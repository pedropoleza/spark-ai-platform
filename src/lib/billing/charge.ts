import { getLocationToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";
import { calculateCost } from "./pricing";
import {
  insertUsageRecord,
  markCustomKeyCharged,
  markCapBlocked,
  getMonthlySpend,
  findStaleUnbilledRecords,
  claimUnbilledBatch,
  reapStaleClaims,
  releaseClaimForRecord,
  markWalletCharged,
} from "@/lib/repositories/usage-records.repo";
import { getMonthlySpendCap } from "@/lib/repositories/agents.repo";
import { createAdminClient } from "@/lib/supabase/admin";

interface TrackUsageParams {
  locationId: string;
  companyId: string;
  agentId: string;
  contactId?: string;
  actionType: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  audioSeconds?: number;          // Whisper
  audioModel?: string;
  imageCount?: number;            // telemetria de vision
  usesCustomKey: boolean;
}

/**
 * Registra uso e cobra do wallet do GHL (se nao usa chave propria).
 *
 * Notas P0 (review 2026-04-28):
 *   - cached_tokens persistido pra auditoria (não estava antes — bug de
 *     sub-cobrança em chamadas com cache hit alto).
 *   - cache_creation_tokens (Anthropic) cobrado como 125% (premium correto).
 *   - audio_seconds + image_count persistidos pra cross-check com providers.
 *   - GHL idempotency key = usage_record.id, evita double-charge em retry
 *     do client side.
 *
 * Erros do INSERT NÃO são engolidos silenciosamente — chamamos console.error
 * pra ficar visível no Vercel log se a tabela não existir / RLS bloquear.
 */
export async function trackAndCharge(params: TrackUsageParams): Promise<void> {
  const cost = calculateCost({
    model: params.model,
    promptTokens: params.promptTokens ?? 0,
    completionTokens: params.completionTokens ?? 0,
    cachedTokens: params.cachedTokens ?? 0,
    cacheCreationTokens: params.cacheCreationTokens ?? 0,
    audioSeconds: params.audioSeconds ?? 0,
    audioModel: params.audioModel,
  });

  // Registrar uso via repo
  const record = await insertUsageRecord({
    location_id: params.locationId,
    agent_id: params.agentId,
    contact_id: params.contactId || null,
    action_type: params.actionType,
    ai_model: cost.model,
    prompt_tokens: cost.promptTokens,
    completion_tokens: cost.completionTokens,
    cached_tokens: cost.cachedTokens,
    total_tokens: cost.totalTokens,
    audio_seconds: cost.audioSeconds,
    image_count: params.imageCount ?? 0,
    cost_usd: cost.costUsd,
    markup_usd: cost.markupUsd,
    total_charge_usd: cost.totalChargeUsd,
    uses_custom_key: params.usesCustomKey,
    charged_to_wallet: false,
  });

  if (!record) {
    // insertUsageRecord já logou o erro
    return;
  }

  // Se usa chave propria (BYO API key) OU é internal team, nao cobra wallet.
  // Audit trail mantido em usage_records (charged_to_wallet=true só pra
  // marcar "tratado" e não voltar no cron de retry).
  if (params.usesCustomKey) {
    await markCustomKeyCharged(record.id);
    return;
  }

  // Hard cap mensal (Pedro 2026-05-04): se atingiu cap da location, marca
  // cap_blocked=true e SKIP charge. Bot continua respondendo (UX preservada),
  // mas custo fica com Pedro até reset mensal ou liberação manual.
  if (cost.totalChargeUsd > 0) {
    const capCheck = await isMonthlyCapReached(
      params.agentId,
      params.locationId,
      cost.totalChargeUsd,
    ).catch(() => ({ blocked: false, cap: 0, spentSoFar: 0 }));

    if (capCheck.blocked) {
      console.warn(
        `[Billing] Cap atingido pra location=${params.locationId}: ` +
        `spent=$${capCheck.spentSoFar.toFixed(2)} + newCharge=$${cost.totalChargeUsd.toFixed(4)} ` +
        `> cap=$${capCheck.cap.toFixed(2)}. Skipping charge.`,
      );
      await markCapBlocked(record.id);
      return;
    }

    // Cobrar do wallet via GHL Marketplace API
    try {
      const ghlChargeId = await chargeWallet(
        params.companyId,
        params.locationId,
        cost.totalChargeUsd,
        params.actionType,
        record.id, // idempotency key
      );

      await markWalletCharged(record.id, ghlChargeId, new Date().toISOString());
    } catch (error) {
      console.error("[Billing] Failed to charge wallet:", error);
      // Nao bloqueia o processamento — cron chargeUnbilledRecords retenta.
    }
  }
}

/**
 * Cobra do wallet da sub-account via GHL Marketplace API (Custom Event metered).
 *
 * Pedro 2026-05-17: API GHL mudou pra modelo de metered billing.
 * Schema antigo (`{locationId, amount, currency}`) retornava 422.
 * Schema novo exige `appId + meterId + eventId + companyId + locationId + units + price`.
 *
 * Idempotency: passamos `eventId` baseado no usage_record.id — GHL usa
 * isso pra dedupar (mesmo eventId não cobra 2x).
 *
 * Envs necessárias:
 *   GHL_MARKETPLACE_APP_ID  — appId do app no Marketplace
 *   GHL_BILLING_METER_ID    — meterId do Custom Event API criado no Pricing
 */
async function chargeWallet(
  companyId: string,
  locationId: string,
  amountUsd: number,
  description: string,
  idempotencyKey?: string,
): Promise<string | null> {
  const appId = process.env.GHL_MARKETPLACE_APP_ID;
  const meterId = process.env.GHL_BILLING_METER_ID;
  if (!appId || !meterId) {
    throw new Error(
      "GHL_MARKETPLACE_APP_ID e/ou GHL_BILLING_METER_ID não configurados em env",
    );
  }

  const token = await getLocationToken(companyId, locationId);
  const eventId = idempotencyKey || `evt-${Date.now()}-${locationId.slice(0, 6)}`;

  const response = await fetch(`${GHL_API_BASE}/marketplace/billing/charges`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({
      appId,
      meterId,
      eventId,
      companyId,
      locationId,
      units: 1, // 1 evento por charge
      price: amountUsd, // dynamic price — valor exato em USD
      description: `Spark AI Hub - ${formatDescription(description)}`,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GHL billing charge failed: ${response.status} - ${errorBody}`);
  }

  // Response: {message, chargeId, maxDailyUnits, dailyUnitsConsumed, traceId}
  try {
    const data = (await response.json()) as { chargeId?: string; id?: string };
    return data.chargeId || data.id || null;
  } catch {
    return null;
  }
}

function formatDescription(actionType: string): string {
  const map: Record<string, string> = {
    ai_processing: "Processamento de mensagem IA",
    follow_up: "Follow-up automatico",
    send_message: "Envio de mensagem",
    audio_transcription: "Transcricao de audio",
    summary_note: "Resumo de conversa",
    history_compression: "Compressao de historico",
    proactive: "Acao proativa do Sparkbot",
    sparkbot: "Conversa com Sparkbot",
  };
  return map[actionType] || actionType;
}

/**
 * Verificar se a sub-account tem saldo suficiente.
 * TODO P2: implementar de verdade. Por enquanto fail-open propositalmente.
 */
export async function checkWalletBalance(
  _companyId: string,
  _locationId: string,
): Promise<boolean> {
  // Fail-open: cliente sem saldo continua usando até implementarmos hard cap.
  // Quando implementar, ler /marketplace/billing/balance e comparar com
  // mediana de spend mensal pra decidir.
  return true;
}

/**
 * Verifica se a sub-account atingiu o hard cap mensal de gasto. Lookup:
 *   1. agent_configs.monthly_spend_cap_usd da location (default $100)
 *   2. SUM(total_charge_usd) das usage_records dessa location no mês corrente
 *
 * Retorna true se DEVE BLOQUEAR (atingiu o cap). False = pode cobrar.
 *
 * Pedro 2026-05-04: usado pra blindar conta do agency owner em caso de
 * runaway (loop, abuso, bug). Bot CONTINUA RESPONDENDO mesmo com cap
 * atingido — apenas para de cobrar (Pedro come o custo até reset mensal).
 * Future: pode evoluir pra notificar admin via webhook quando atingir 80%.
 */
export async function isMonthlyCapReached(
  agentId: string,
  locationId: string,
  newChargeUsd: number,
): Promise<{ blocked: boolean; cap: number; spentSoFar: number }> {
  // 1. Lê cap da config (default 100). Se NULL explicitamente, sem cap.
  const agentConfig = await getMonthlySpendCap(agentId);

  const cap = agentConfig?.monthly_spend_cap_usd;
  if (cap === null || cap === undefined) {
    return { blocked: false, cap: Number.POSITIVE_INFINITY, spentSoFar: 0 };
  }
  const capUsd = Number(cap);
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return { blocked: false, cap: capUsd, spentSoFar: 0 };
  }

  // 2. SUM total_charge_usd dessa location no mês corrente
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // Fix Track 10 C2 (review 2026-05-05): conta TODOS tracked com
  // total_charge_usd > 0 (exceto cap_blocked) — ver getMonthlySpend no repo.
  const rows = await getMonthlySpend(locationId, startOfMonth.toISOString());

  const spent = rows.reduce(
    (acc, r) => acc + (Number(r.total_charge_usd) || 0),
    0,
  );

  return {
    blocked: spent + newChargeUsd > capUsd,
    cap: capUsd,
    spentSoFar: spent,
  };
}

/**
 * Cobra registros pendentes que falharam anteriormente.
 *
 * P1 (review 2026-04-28): claim atômico (SELECT ids → UPDATE by ids, bounded)
 * pra evitar 2 crons concorrentes pegarem o mesmo batch.
 *   1. claimUnbilledBatch reivindica até N rows não-claimed e marca com nosso
 *      token. Cada row é atribuída a UM claim (concorrência segura).
 *   2. Apenas as rows reivindicadas por nós são processadas.
 *   3. Em caso de falha por record, claim é resetado no catch (retry).
 *
 * C3-1/P0-3 (ultra-review 2026-05-26): ANTES do claim, roda o reaper que solta
 * claims órfãos (>15min, não cobrados) — o caso em que uma execução anterior
 * morreu por timeout no meio do loop e deixou records travados pra sempre. Sem
 * isso, 192 records (~$15) ficaram presos desde 2026-05-21.
 */
export async function chargeUnbilledRecords(): Promise<{ charged: number; failed: number; reaped: number; errors: string[] }> {
  const supabase = createAdminClient();
  let charged = 0;
  let failed = 0;
  // Observabilidade: coleta amostras de erro de charge (até 5) pra surfacear na
  // resposta do cron — sem depender de log do Vercel. Ajuda a diagnosticar
  // falhas recorrentes do GHL wallet (ex: dup eventId, token, 4xx).
  const errors: string[] = [];
  const sampleErr = (recordId: string, msg: string) => {
    if (errors.length < 5) errors.push(`${recordId}: ${msg}`);
  };

  // Reaper de claims órfãos (C3-1/P0-3): solta records reivindicados há >15min
  // que nunca foram cobrados nem liberados (lambda morreu no loop). Eles voltam
  // a ser elegíveis ao claim abaixo. Roda SEMPRE, antes de tudo.
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const reaped = await reapStaleClaims(fifteenMinAgo);
  if (reaped > 0) {
    console.warn(`[Billing] Reaper soltou ${reaped} claim(s) órfão(s) (>15min, não cobrados) pra retry.`);
  }

  // Alerta: registros unbilled antigos indicam problema recorrente com o GHL wallet.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const staleStats = await findStaleUnbilledRecords(oneHourAgo);

  if (staleStats.length > 0) {
    const totalStale = staleStats.reduce((s, r) => s + Number(r.total_charge_usd || 0), 0);
    if (staleStats.length >= 100 || totalStale >= 10) {
      console.error(
        `[Billing ALERT] ${staleStats.length} unbilled records older than 1h, total $${totalStale.toFixed(4)}. Investigate wallet charge failures.`,
      );
    } else {
      console.warn(
        `[Billing] ${staleStats.length} unbilled records older than 1h, total $${totalStale.toFixed(4)}`,
      );
    }
  }

  // Claim atômico via repo (SELECT ids → UPDATE by ids) com filters de
  // idempotência (P1 review 2026-04-28, Fix Track 10 H4 review 2026-05-05).
  // Batch bounded em 40: agora que claimUnbilledBatch limita de verdade, 40
  // charges sequenciais ao GHL cabem com folga nos 60s da lambda (margem de
  // segurança). O cron dedicado (5min) drena o resto nos runs seguintes.
  const claimToken = (globalThis.crypto as Crypto).randomUUID();
  const claimed = await claimUnbilledBatch(claimToken, new Date().toISOString(), 40);

  if (claimed.length === 0) return { charged: 0, failed: 0, reaped, errors };

  // Cache location → company_id pra evitar N queries
  const locCompanyCache = new Map<string, string | null>();
  async function getCompanyId(locationId: string): Promise<string | null> {
    if (locCompanyCache.has(locationId)) return locCompanyCache.get(locationId)!;
    const { data } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", locationId)
      .maybeSingle();
    const companyId = data?.company_id ?? null;
    locCompanyCache.set(locationId, companyId);
    return companyId;
  }

  // Fix Pedro 2026-05-17: cobrar 1 record por vez (não agrupar em batch).
  // Schema novo de metered billing tem Max Price per Unit ($5) — batches
  // grandes (ex: rep com 30 records somando $3.85) podem somar acima do
  // limite e retornar 400 "Price is not within the allowed range". Records
  // individuais sempre cabem (price médio $0.01-$0.30 por turn).
  // Idempotency: eventId = usage_record.id → GHL não duplica em retry.
  for (const record of claimed) {
    try {
      const companyId = await getCompanyId(record.location_id);
      if (!companyId) {
        failed++;
        sampleErr(record.id, `sem company_id pra location ${record.location_id}`);
        await releaseClaimForRecord(record.id);
        continue;
      }

      const ghlChargeId = await chargeWallet(
        companyId,
        record.location_id,
        Number(record.total_charge_usd),
        record.action_type || "ai_turn",
        record.id, // eventId pro GHL — idempotência por record
      );

      await markWalletCharged(record.id, ghlChargeId, new Date().toISOString());
      charged++;
    } catch (err) {
      failed++;
      // Libera claim pra próxima tentativa (não loga retries pra evitar spam)
      await releaseClaimForRecord(record.id);
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      sampleErr(record.id, msg);
      console.warn(`[Billing] Single charge failed for record ${record.id}: ${msg}`);
    }
  }

  return { charged, failed, reaped, errors };
}
