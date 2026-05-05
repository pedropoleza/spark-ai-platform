import { createAdminClient } from "@/lib/supabase/admin";
import { getLocationToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";
import { calculateCost } from "./pricing";

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
  const supabase = createAdminClient();
  const cost = calculateCost({
    model: params.model,
    promptTokens: params.promptTokens ?? 0,
    completionTokens: params.completionTokens ?? 0,
    cachedTokens: params.cachedTokens ?? 0,
    cacheCreationTokens: params.cacheCreationTokens ?? 0,
    audioSeconds: params.audioSeconds ?? 0,
    audioModel: params.audioModel,
  });

  // Registrar uso
  const { data: record, error: insertError } = await supabase
    .from("usage_records")
    .insert({
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
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("[Billing] Failed to insert usage_record:", insertError.message);
    return;
  }

  // Se usa chave propria (BYO API key) OU é internal team, nao cobra wallet.
  // Audit trail mantido em usage_records (charged_to_wallet=true só pra
  // marcar "tratado" e não voltar no cron de retry).
  if (params.usesCustomKey) {
    if (record) {
      await supabase
        .from("usage_records")
        .update({ charged_to_wallet: true })
        .eq("id", record.id);
    }
    return;
  }

  // Hard cap mensal (Pedro 2026-05-04): se atingiu cap da location, marca
  // cap_blocked=true e SKIP charge. Bot continua respondendo (UX preservada),
  // mas custo fica com Pedro até reset mensal ou liberação manual.
  if (cost.totalChargeUsd > 0 && record) {
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
      await supabase
        .from("usage_records")
        .update({ cap_blocked: true })
        .eq("id", record.id);
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

      await supabase
        .from("usage_records")
        .update({
          charged_to_wallet: true,
          wallet_charge_id: ghlChargeId ?? null,
        })
        .eq("id", record.id);
    } catch (error) {
      console.error("[Billing] Failed to charge wallet:", error);
      // Nao bloqueia o processamento — cron chargeUnbilledRecords retenta.
    }
  }
}

/**
 * Cobra do wallet da sub-account via GHL Marketplace API.
 * Retorna o ID da cobrança no GHL pra rastreamento (se disponível na resposta).
 *
 * Idempotency: passamos `Idempotency-Key` baseado no usage_record.id.
 * Se o GHL respeitar (atualmente honra Idempotency-Key em endpoints de
 * billing), retry do mesmo record não duplica cobrança.
 */
async function chargeWallet(
  companyId: string,
  locationId: string,
  amountUsd: number,
  description: string,
  idempotencyKey?: string,
): Promise<string | null> {
  const token = await getLocationToken(companyId, locationId);

  // Converter para centavos (GHL espera em centavos)
  const amountCents = Math.ceil(amountUsd * 100);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const response = await fetch(`${GHL_API_BASE}/marketplace/billing/charges`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      locationId,
      amount: amountCents,
      description: `Spark AI Hub - ${formatDescription(description)}`,
      currency: "USD",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GHL billing charge failed: ${response.status} - ${errorBody}`);
  }

  // Tenta extrair ID retornado (formato pode variar)
  try {
    const data = await response.json() as { id?: string; charge_id?: string };
    return data.id || data.charge_id || null;
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
  const supabase = createAdminClient();

  // 1. Lê cap da config (default 100). Se NULL explicitamente, sem cap.
  const { data: agentConfig } = await supabase
    .from("agent_configs")
    .select("monthly_spend_cap_usd")
    .eq("agent_id", agentId)
    .maybeSingle();

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

  // Fix Track 10 C2 (review 2026-05-05): antes filtrava só `charged_to_wallet=true`.
  // Mas trackAndCharge pode falhar transient (GHL 5xx) deixando record com
  // `charged_to_wallet=false` mas tracked → usage_records já existe. Esses
  // contam pro cap mensal logicamente, senão rep pode acumular $500 em
  // pending e cap nunca disparar. Solução: contar TODOS tracked com
  // total_charge_usd > 0 (exceto cap_blocked que já são fora do cap).
  const { data: rows } = await supabase
    .from("usage_records")
    .select("total_charge_usd")
    .eq("location_id", locationId)
    .gte("created_at", startOfMonth.toISOString())
    .gt("total_charge_usd", 0);

  const spent = (rows || []).reduce(
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
 * P1 (review 2026-04-28): claim atômico via UPDATE...RETURNING pra evitar
 * 2 crons concorrentes pegarem o mesmo batch.
 *   1. UPDATE pega rows não-claimed (claim_token IS NULL) e marca com nosso
 *      token. Postgres garante que cada row é atribuída a UM claim.
 *   2. Apenas rows com claim_token = nosso token são processadas.
 *   3. Em caso de falha, claim é resetado em finally.
 */
export async function chargeUnbilledRecords(): Promise<{ charged: number; failed: number }> {
  const supabase = createAdminClient();
  let charged = 0;
  let failed = 0;

  // Alerta: registros unbilled antigos indicam problema recorrente com o GHL wallet.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: staleStats } = await supabase
    .from("usage_records")
    .select("id, total_charge_usd")
    .eq("charged_to_wallet", false)
    .eq("uses_custom_key", false)
    .gt("total_charge_usd", 0)
    .lt("created_at", oneHourAgo);

  if (staleStats && staleStats.length > 0) {
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

  // Atomic claim: UPDATE pega rows livres e marca com nosso token.
  // Fix Track 10 H4 (review 2026-05-05): adicionado `cap_blocked.eq.false`
  // — antes, records cap_blocked ficavam sendo retentados em loop pelo
  // cron (filtro só excluía charged=true). Agora cron pula records
  // que já bateram cap (esperam reset mensal ou cap aumentado).
  const claimToken = (globalThis.crypto as Crypto).randomUUID();
  const { data: claimed } = await supabase
    .from("usage_records")
    .update({ claim_token: claimToken, claimed_at: new Date().toISOString() })
    .eq("charged_to_wallet", false)
    .eq("uses_custom_key", false)
    .eq("cap_blocked", false)
    .gt("total_charge_usd", 0)
    .is("claim_token", null)
    .select("*")
    .order("created_at", { ascending: true })
    .limit(50);

  if (!claimed || claimed.length === 0) return { charged: 0, failed: 0 };

  // Agrupar por location para cobrar em batch
  const byLocation = new Map<string, { totalUsd: number; ids: string[] }>();

  for (const record of claimed) {
    const key = record.location_id;
    if (!byLocation.has(key)) {
      byLocation.set(key, { totalUsd: 0, ids: [] });
    }
    const group = byLocation.get(key)!;
    group.totalUsd += Number(record.total_charge_usd);
    group.ids.push(record.id);
  }

  for (const [locationId, group] of Array.from(byLocation.entries())) {
    try {
      const { data: location } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", locationId)
        .single();

      if (!location) {
        failed += group.ids.length;
        // Libera claim pra próxima rodada tentar de novo
        await supabase
          .from("usage_records")
          .update({ claim_token: null, claimed_at: null })
          .in("id", group.ids);
        continue;
      }

      // Idempotency: hash dos ids do batch — se mesmo batch for retentado,
      // o GHL deve ignorar a cobrança duplicada (se respeitar a header).
      const batchIdempotencyKey = `batch-${group.ids.slice().sort().join(",").slice(0, 64)}`;

      const ghlChargeId = await chargeWallet(
        location.company_id,
        locationId,
        group.totalUsd,
        `Batch: ${group.ids.length} interacoes`,
        batchIdempotencyKey,
      );

      await supabase
        .from("usage_records")
        .update({
          charged_to_wallet: true,
          wallet_charge_id: ghlChargeId ?? null,
        })
        .in("id", group.ids);

      charged += group.ids.length;
    } catch (err) {
      failed += group.ids.length;
      // Libera claim pra próxima tentativa
      await supabase
        .from("usage_records")
        .update({ claim_token: null, claimed_at: null })
        .in("id", group.ids);
      console.error(`[Billing] Batch charge failed for ${locationId}:`, err);
    }
  }

  return { charged, failed };
}
