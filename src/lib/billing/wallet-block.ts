/**
 * Bloqueio por wallet sem saldo (Pedro 2026-07-17, ultra-review P0-2).
 *
 * Decisão do Pedro: location sem crédito → IA BLOQUEIA (não responde de graça)
 * e avisa que o saldo acabou — recarga na wallet do Spark Leads; dúvidas no
 * suporte. Antes, a cobrança falhava a cada turno ("insufficient funds",
 * ~$72 acumulados em 2 locations) e o serviço seguia rodando de graça em
 * silêncio.
 *
 * Mecânica:
 *  - charge.ts marca `locations.wallet_blocked_at` quando o GHL devolve
 *    "insufficient funds" e LIMPA quando uma cobrança volta a passar (o cron
 *    de retry cobra os pendentes → cliente recarregou → desbloqueia sozinho
 *    em ~15min, sem ação manual).
 *  - Gates de runtime (processor / queue-processor / dispatcher proativo)
 *    consultam isWalletBlocked() (cache em memória 60s) e param ANTES de
 *    gastar LLM.
 *  - Rep is_internal NÃO é bloqueado (não gera cobrança por design).
 *  - Kill-switch de emergência: WALLET_BLOCK_DISABLED=1 desativa os gates.
 */
import { createAdminClient } from "@/lib/supabase/admin";

// Número do suporte Spark (Pedro 2026-07-27): era o telefone PESSOAL do Pedro
// (+1 786 771-7077) por engano — trocado pelo número oficial do suporte.
const SUPPORT_PHONE = "+1 (786) 627-6787";

// H60 (caso Wesley 2026-08-01): o aviso agora ENSINA o caminho da recarga e a
// recarga automática — antes só dizia "adiciona saldo" e o cliente não sabia
// onde. ATENÇÃO: a frase "créditos de IA desta conta acabaram" é o MARCADOR do
// cooldown de 4h (shouldSendWalletBlockedRepMessage casa por conteúdo) — se
// mudar a copy, preservar esse trecho ou migrar o marcador junto.
// Nota: NÃO sugerir "gatilho acima de $0" — o HL trava o auto-recharge em
// "< $0" (Pedro conferiu o dropdown 2026-07-27); é o auto-drain (00127) que
// faz esse gatilho disparar zerando o residual.
const RECHARGE_HOWTO =
  "no Spark Leads, abre Configurações → Faturamento → Carteira e Recarga e adiciona saldo " +
  "— o bot volta sozinho em poucos minutos. 💡 Dica: deixa a *recarga automática* ativa " +
  "ali pra não parar de novo.";

/** Resposta determinística pro REP quando a location dele está sem saldo. */
export const WALLET_BLOCKED_REP_MESSAGE =
  "⚠️ Os créditos de IA desta conta acabaram, então precisei pausar por aqui. " +
  `Pra reativar: ${RECHARGE_HOWTO} ` +
  `Qualquer dúvida, chama o suporte: ${SUPPORT_PHONE} 👍`;

/** Aviso (1x/24h) pra dona da conta quando os agentes lead-facing param. */
export const WALLET_BLOCKED_OWNER_MESSAGE =
  "⚠️ Os créditos de IA da conta acabaram — pausei o SparkBot e os agentes de IA " +
  "(os leads não estão recebendo resposta automática). Pra reativar: " +
  `${RECHARGE_HOWTO} Dúvidas, chama o suporte: ${SUPPORT_PHONE}`;

/** Detecta o 400 de saldo do GHL sem acoplar no corpo exato do erro. */
export function isInsufficientFundsError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /insufficient\s+funds/i.test(msg);
}

function isDisabled(): boolean {
  return process.env.WALLET_BLOCK_DISABLED === "1";
}

/**
 * Auto-drain do residual da wallet (Pedro 2026-07-27) — flag OFF por default.
 * Quando ligada, o cron de retry tenta zerar o residual encalhado pra disparar
 * o auto-recharge do HL. Ver charge.ts:drainAndRetry + migration 00127.
 */
export function isAutoDrainEnabled(): boolean {
  return process.env.WALLET_AUTO_DRAIN_ENABLED === "1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Carência de débito (H60, caso Wesley 2026-08-01)
//
// O GHL rejeita QUALQUER cobrança maior que o saldo — não deixa cruzar o zero.
// O Wesley tinha $0.31 na wallet, o turno custou $0.40 → 400 "insufficient
// funds" → a location bloqueava NA PRIMEIRA falha, com saldo visível no painel
// ("tenho crédito, por que parou?"). Decisão do Pedro (2026-08-01): a falha de
// cobrança vira DÉBITO do SparkBot até um teto pequeno — o bot continua
// respondendo (UX preservada, mesmo espírito do cap mensal), o cron de retry
// (5min) recobra sozinho quando a recarga cai, e só bloqueia de verdade quando
// o débito acumulado da location cruza a carência. Perda máxima por location =
// WALLET_GRACE_USD (default $2). WALLET_GRACE_USD=0 restaura o H52 puro
// (bloqueio na 1ª falha).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_GRACE_USD = 2;

/** Teto de débito tolerado por location antes de bloquear (0 = sem carência). */
export function walletGraceUsd(): number {
  const raw = process.env.WALLET_GRACE_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GRACE_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_USD;
}

/**
 * Débito em aberto da location: records que JÁ falharam cobrança (têm
 * charge_fail_reason) e seguem não-cobrados. Janela de 30d — pendência mais
 * velha que isso é artefato de bug antigo, não débito vivo. Client-side sum:
 * a carência (~$2) cabe em poucas dezenas de records de $0.01-$0.40.
 */
export async function getUnpaidDebtUsd(locationId: string): Promise<number> {
  const supabase = createAdminClient();
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("usage_records")
    .select("total_charge_usd")
    .eq("location_id", locationId)
    .eq("charged_to_wallet", false)
    .is("charged_at", null)
    .eq("cap_blocked", false)
    .eq("uses_custom_key", false)
    .not("charge_fail_reason", "is", null)
    .gte("created_at", sinceIso)
    .limit(500);
  if (error) throw error;
  return (data || []).reduce((acc, r) => acc + (Number((r as { total_charge_usd?: unknown }).total_charge_usd) || 0), 0);
}

export interface GraceDecision {
  block: boolean;
  debtUsd: number;
  graceUsd: number;
}

/**
 * Depois de um "insufficient funds": bloquear já, ou segurar em carência?
 * Chamar DEPOIS do markChargeFailReason do record atual (pra ele contar no
 * débito). Fail-OPEN: erro lendo o débito NÃO bloqueia (bloquear cliente por
 * falha de leitura NOSSA é o bug que estamos matando; o teto de perda real
 * segue sendo o cap mensal).
 */
export async function shouldBlockAfterInsufficient(locationId: string): Promise<GraceDecision> {
  const graceUsd = walletGraceUsd();
  if (graceUsd <= 0) return { block: true, debtUsd: -1, graceUsd };
  try {
    const debtUsd = await getUnpaidDebtUsd(locationId);
    return { block: debtUsd >= graceUsd, debtUsd, graceUsd };
  } catch (err) {
    console.warn("[wallet-block] leitura de débito falhou — mantendo em carência (fail-open):", err);
    return { block: false, debtUsd: -1, graceUsd };
  }
}

/**
 * Cooldown do aviso ao REP (D3 do diagnóstico 2026-07-20, implementado no H60):
 * antes, TODA mensagem do rep numa location bloqueada devolvia o "créditos
 * acabaram" (Jussara levou 6 seguidos). Agora ≤1 a cada 4h por rep — dedup
 * determinístico pelo próprio histórico persistido (cross-lambda), casando o
 * MARCADOR da copy. Fail-open: erro de leitura → manda (avisar 2x < nunca).
 */
export async function shouldSendWalletBlockedRepMessage(repId: string): Promise<boolean> {
  if (!repId) return true;
  try {
    const supabase = createAdminClient();
    const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("sparkbot_messages")
      .select("id")
      .eq("rep_id", repId)
      .eq("role", "agent")
      .ilike("content", "%créditos de IA desta conta acabaram%")
      .gte("created_at", cutoff)
      .limit(1);
    return !(data && data.length > 0);
  } catch {
    return true;
  }
}

/**
 * CAS: reivindica a (única) tentativa de auto-drain deste episódio de bloqueio.
 * Retorna true SÓ pra quem ganha (wallet_drain_attempted_at estava NULL). Garante
 * ≤1 dreno por episódio (o flag é limpo junto com wallet_blocked_at no
 * clearWalletBlock) — é o teto do vazamento caso o dreno não zere a wallet.
 * Fail-soft: qualquer erro = false (não drena, cai no bloqueio normal).
 */
export async function claimDrainAttempt(locationId: string): Promise<boolean> {
  if (!locationId) return false;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("locations")
      .update({ wallet_drain_attempted_at: new Date().toISOString() })
      .eq("location_id", locationId)
      .is("wallet_drain_attempted_at", null)
      .select("location_id");
    return !!(data && data.length > 0);
  } catch {
    return false;
  }
}

// Cache em memória (por lambda warm) — no pior caso 1 query/location/min.
const cache = new Map<string, { blocked: boolean; at: number }>();
const CACHE_TTL_MS = 60_000;

/** A location está bloqueada por saldo? Fail-OPEN: erro de leitura = false. */
export async function isWalletBlocked(locationId: string): Promise<boolean> {
  if (isDisabled() || !locationId) return false;
  const hit = cache.get(locationId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.blocked;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("locations")
      .select("wallet_blocked_at")
      .eq("location_id", locationId)
      .maybeSingle();
    const blocked = !!data?.wallet_blocked_at;
    cache.set(locationId, { blocked, at: Date.now() });
    return blocked;
  } catch {
    return false; // fail-open: problema NOSSO de leitura nunca cala a IA do cliente
  }
}

/** Marca a location como bloqueada (1ª falha por saldo). Idempotente. */
export async function markWalletBlocked(
  locationId: string,
  sampleError?: string,
): Promise<void> {
  if (!locationId) return;
  try {
    const supabase = createAdminClient();
    const nowIso = new Date().toISOString();
    const { data: updated } = await supabase
      .from("locations")
      .update({ wallet_blocked_at: nowIso, updated_at: nowIso })
      .eq("location_id", locationId)
      .is("wallet_blocked_at", null)
      .select("location_id");
    cache.set(locationId, { blocked: true, at: Date.now() });
    if (updated && updated.length > 0) {
      // Sinal SÓ na transição liberada→bloqueada (recorder dedupa por título,
      // então re-bloqueio da mesma location incrementa occurrence, não duplica).
      const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
      recordSignalAsync({
        type: "failure",
        title: `💳 Wallet sem saldo — IA bloqueada (${locationId})`,
        description:
          "Cobrança devolveu 'insufficient funds' pra essa location. A IA (SparkBot + " +
          "agentes lead-facing + proativos) está BLOQUEADA até recarregarem a wallet do " +
          "Spark Leads — o desbloqueio é automático quando uma cobrança voltar a passar. " +
          (sampleError ? `Erro: ${sampleError.slice(0, 200)}` : ""),
        severity: "high",
        source: "bot_auto",
        metadata: { location_id: locationId, blocked_at: nowIso },
      });
    }
  } catch (err) {
    console.warn("[wallet-block] markWalletBlocked falhou (não-fatal):", err);
  }
}

/**
 * Limpa o bloqueio quando uma cobrança volta a passar (recarga feita).
 *
 * H52 review adversarial (2026-07-17): é chamada INCONDICIONALMENTE após
 * cobrança OK — o caminho de desbloqueio NUNCA pode passar por isWalletBlocked
 * (o kill-switch WALLET_BLOCK_DISABLED e o cache de 60s curto-circuitariam o
 * clear e a location ficaria muda pra sempre ao religar a flag). O SELECT
 * inicial torna a chamada barata no caminho comum (não-bloqueada).
 */
export async function clearWalletBlock(locationId: string): Promise<void> {
  if (!locationId) return;
  try {
    const supabase = createAdminClient();
    // Âncora do reenqueue (e no-op barato quando nem estava bloqueada).
    const { data: loc } = await supabase
      .from("locations")
      .select("wallet_blocked_at, wallet_drain_attempted_at")
      .eq("location_id", locationId)
      .maybeSingle();
    const blockedAt = (loc?.wallet_blocked_at as string | null | undefined) || null;
    if (!blockedAt) {
      // Não bloqueada. Mas se sobrou um CAS de dreno órfão (o dreno resolveu com
      // wallet_blocked_at já NULL — ex: falha transiente não-insufficient antes,
      // que pula o markWalletBlocked), limpa aqui pra não aposentar o auto-drain
      // nessa location pra sempre. Só escreve se REALMENTE há flag pendente (o
      // caminho comum, não-bloqueada e sem dreno, continua sendo só o SELECT).
      if (loc?.wallet_drain_attempted_at) {
        await supabase
          .from("locations")
          .update({ wallet_drain_attempted_at: null })
          .eq("location_id", locationId);
      }
      cache.set(locationId, { blocked: false, at: Date.now() });
      return;
    }
    const { data: updated } = await supabase
      .from("locations")
      .update({
        wallet_blocked_at: null,
        wallet_block_notified_at: null,
        // Auto-drain (Pedro 2026-07-27): recarregou → reseta o CAS do dreno pra
        // um episódio futuro poder tentar de novo (o teto de ≤1 dreno é POR
        // episódio de bloqueio, não pra sempre).
        wallet_drain_attempted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("location_id", locationId)
      .not("wallet_blocked_at", "is", null)
      .select("location_id");
    cache.set(locationId, { blocked: false, at: Date.now() });
    if (!updated || updated.length === 0) return; // outra lambda limpou antes
    const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
    recordSignalAsync({
      type: "failure",
      title: `💚 Wallet recarregada — IA reativada (${locationId})`,
      description:
        "Uma cobrança voltou a passar nessa location; o bloqueio por saldo foi removido automaticamente. " +
        "Inbounds de leads engolidos durante o bloqueio foram re-enfileirados (janela ≤24h).",
      severity: "medium",
      source: "bot_auto",
      metadata: { location_id: locationId, blocked_at: blockedAt },
    });
    // H52 review adversarial: leads que escreveram DURANTE o bloqueio foram
    // consumidos como 'completed' no message_queue — sem isto ficariam mudos
    // pra sempre mesmo após a recarga (lead quente de anúncio perdido).
    await reenqueueWalletSwallowed(supabase, locationId, blockedAt);
  } catch (err) {
    console.warn("[wallet-block] clearWalletBlock falhou (não-fatal):", err);
  }
}

/**
 * Re-enfileira os inbounds de lead engolidos pelo gate de wallet (auditados em
 * execution_log action_type='wallet_blocked_skip'). Reusa o mecanismo do
 * resume de ai_paused (reenqueueInboundsSincePause: piso de 24h embutido).
 * Fail-soft; cap de 50 pares (agente, contato) por desbloqueio.
 */
async function reenqueueWalletSwallowed(
  supabase: ReturnType<typeof createAdminClient>,
  locationId: string,
  blockedAtIso: string,
): Promise<void> {
  try {
    // MC-4 (review Marcia 2026-07-28, substitui o head-window do H52 R2): a
    // janela cega de +90s perdia mensagens decisivas engolidas logo APÓS o
    // bloqueio (Valéria disse "Quinta 2pm" 45s depois do block e nunca foi
    // respondida). Agora a janela começa NO bloqueio e o "já foi respondida?"
    // é decidido POR RESULTADO, não por tempo: o par só é pulado se houve
    // send_message success DEPOIS do último wallet_blocked_skip dele.
    const sinceIso = blockedAtIso;
    const { data: skips } = await supabase
      .from("execution_log")
      .select("agent_id, contact_id, created_at")
      .eq("location_id", locationId)
      .eq("action_type", "wallet_blocked_skip")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(200);
    const pairs = new Map<string, { agentId: string; contactId: string; lastSkipAt: string }>();
    for (const s of skips || []) {
      const a = (s as { agent_id?: string }).agent_id;
      const c = (s as { contact_id?: string }).contact_id;
      const at = (s as { created_at?: string }).created_at || sinceIso;
      if (!a || !c) continue;
      const key = `${a}|${c}`;
      // skips vêm DESC → o primeiro visto é o mais recente do par.
      if (!pairs.has(key)) pairs.set(key, { agentId: a, contactId: c, lastSkipAt: at });
    }
    if (pairs.size === 0) return;
    if (pairs.size > 50) {
      console.warn(
        `[wallet-block] ${pairs.size} conversas engolidas no bloqueio da ${locationId} — re-enfileirando as 50 mais recentes (cap).`,
      );
    }
    const { reenqueueInboundsSincePause } = await import("@/lib/queue/resume-reenqueue");
    // MC-4: janela real do episódio (blackout de 40h > piso antigo de 24h),
    // capada em 7d por segurança.
    const episodeMs = Math.max(0, Date.now() - new Date(blockedAtIso).getTime());
    const windowMs = Math.min(7 * 24 * 60 * 60 * 1000, episodeMs + 60 * 60 * 1000);
    let total = 0;
    for (const p of [...pairs.values()].slice(0, 50)) {
      // H52 R2: se o registro mais recente da conversa é um OUTBOUND (humano
      // respondeu pelo inbox durante o bloqueio, ou outra automação), NÃO
      // re-enfileira — o bot re-responder colidiria com quem já atendeu.
      const { data: lastRow } = await supabase
        .from("message_queue")
        .select("message_direction")
        .eq("agent_id", p.agentId)
        .eq("contact_id", p.contactId)
        .order("received_at", { ascending: false })
        .limit(1);
      if (lastRow?.[0]?.message_direction === "outbound") continue;
      // MC-4: dedupe POR RESULTADO — se a IA JÁ respondeu depois do último skip
      // (ex: o cache de 60s deixou um turno passar), não re-enfileira (evita a
      // resposta em dobro que o head-window de 90s tentava prevenir por tempo).
      const { data: sentAfter } = await supabase
        .from("execution_log")
        .select("id")
        .eq("agent_id", p.agentId)
        .eq("contact_id", p.contactId)
        .eq("action_type", "send_message")
        .eq("success", true)
        .gt("created_at", p.lastSkipAt)
        .limit(1);
      if (sentAfter && sentAfter.length > 0) continue;
      const r = await reenqueueInboundsSincePause(supabase, {
        agentId: p.agentId,
        contactId: p.contactId,
        pausedSince: sinceIso,
        pausedReason: "wallet_blocked",
        windowMs,
        // MC-5: recovery não pode morrer no targeting (a tag pode ter flipado
        // durante o bloqueio — burst de 21/07 perdeu 25 leads exatamente assim).
        bypassTargeting: true,
      });
      total += r.requeued;
    }
    if (total > 0) {
      console.log(
        `[wallet-block] desbloqueio da ${locationId}: ${total} inbound(s) de lead re-enfileirados (${pairs.size} conversas).`,
      );
    }
  } catch (err) {
    console.warn("[wallet-block] reenqueue pós-desbloqueio falhou (não-fatal):", err);
  }
}

/**
 * Aviso à dona da conta (1x/24h por location) de que a IA parou por saldo —
 * entrega determinística via SparkBot (sem LLM; a location bloqueada não gasta
 * nada pra avisar). Fail-soft: nunca lança.
 */
export async function notifyWalletBlockOwnerOnce(locationId: string): Promise<void> {
  if (isDisabled() || !locationId) return;
  try {
    const supabase = createAdminClient();
    const { data: loc } = await supabase
      .from("locations")
      .select("wallet_blocked_at, wallet_block_notified_at")
      .eq("location_id", locationId)
      .maybeSingle();
    if (!loc?.wallet_blocked_at) return;

    // 2026-08-14 (review 30/07–13/08: Renan recebeu o MESMO aviso diário por 14
    // dias; a 5XQL está bloqueada desde 17/07 sem ninguém agir). Depois de 7
    // dias o aviso diário é fadiga, não informação: vira SEMANAL e o caso escala
    // pro admin (sinal com fingerprint estável — occurrences agregam por dia).
    const bloqueadaHaMs = Date.now() - new Date(loc.wallet_blocked_at as string).getTime();
    const bloqueioVelho = bloqueadaHaMs > 7 * 24 * 60 * 60 * 1000;
    const cooldownMs = bloqueioVelho ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (bloqueioVelho) {
      try {
        const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
        recordSignalAsync({
          type: "failure",
          title: `💳 Wallet bloqueada há mais de 7 dias (${locationId})`,
          description:
            `Location ${locationId} está sem saldo desde ${String(loc.wallet_blocked_at).slice(0, 10)} ` +
            `(${Math.floor(bloqueadaHaMs / 86_400_000)} dias). O aviso automático à dona já virou semanal — ` +
            `esse cliente precisa de contato humano (recarga ou desligamento da conta).`,
          severity: "high",
          source: "bot_auto",
          metadata: { location_id: locationId, blocked_days: Math.floor(bloqueadaHaMs / 86_400_000) },
        });
      } catch {
        /* sinal não crítico */
      }
    }

    const prevNotifiedAt = (loc.wallet_block_notified_at as string | null) || null;
    const last = prevNotifiedAt ? new Date(prevNotifiedAt).getTime() : 0;
    if (Date.now() - last < cooldownMs) return;
    // H52 review adversarial: resolve a dona ANTES de queimar o cooldown —
    // location lead-facing-only (sem rep no SparkBot) não pode gastar as 24h
    // num aviso que nunca sai. Dona = rep não-internal mais recente.
    const { data: reps } = await supabase
      .from("rep_identities")
      .select("id, phone, last_inbound_at")
      .eq("active_location_id", locationId)
      .eq("is_internal", false)
      .order("last_inbound_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const owner = reps?.[0];
    if (!owner?.phone) {
      // Sem dona alcançável via SparkBot → sinal dedicado (fingerprint por
      // location dedupa) pro Pedro avisar por outro canal.
      const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
      recordSignalAsync({
        type: "failure",
        title: `💳 Wallet bloqueada e SEM dona alcançável (${locationId})`,
        description:
          "Location bloqueada por saldo, mas não há rep não-internal com telefone nessa location pra receber o aviso via SparkBot. Avisar o cliente por outro canal.",
        severity: "high",
        source: "bot_auto",
        metadata: { location_id: locationId },
      });
      return;
    }
    // CAS do cooldown (H52 review adversarial): só quem GANHA o UPDATE envia —
    // corrida de 2 lambdas não vira aviso duplo, e perder a corrida não perde
    // o aviso (o vencedor envia). Cutoff acompanha o cooldown dinâmico (24h/7d).
    const cutoff = new Date(Date.now() - cooldownMs).toISOString();
    const nowIso = new Date().toISOString();
    const { data: won } = await supabase
      .from("locations")
      .update({ wallet_block_notified_at: nowIso })
      .eq("location_id", locationId)
      // H52 R2: re-checa o bloqueio ATIVO no próprio CAS — se o clear rodou
      // entre o SELECT lá em cima e aqui, não manda "pausei" pra quem acabou
      // de recarregar (nem carimba cooldown numa location já liberada).
      .not("wallet_blocked_at", "is", null)
      .or(`wallet_block_notified_at.is.null,wallet_block_notified_at.lt.${cutoff}`)
      .select("location_id");
    if (!won || won.length === 0) return; // outra lambda enviou
    const { deliverProactiveMessage } = await import(
      "@/lib/account-assistant/proactive/whatsapp-delivery"
    );
    try {
      await deliverProactiveMessage(
        { id: owner.id, phone: owner.phone, last_inbound_at: null },
        WALLET_BLOCKED_OWNER_MESSAGE,
        {
          activeLocationId: locationId,
          source: "wallet_block_notification",
          kind: "wallet_blocked",
          extraMetadata: { location_id: locationId },
        },
      );
    } catch (deliveryErr) {
      // Entrega falhou → devolve o cooldown pro valor anterior (best-effort)
      // pra próxima tentativa não esperar 24h por um aviso que nunca saiu.
      await supabase
        .from("locations")
        .update({ wallet_block_notified_at: prevNotifiedAt })
        .eq("location_id", locationId)
        .eq("wallet_block_notified_at", nowIso);
      throw deliveryErr;
    }
  } catch (err) {
    console.warn("[wallet-block] notifyWalletBlockOwnerOnce falhou (não-fatal):", err);
  }
}

/**
 * Varredura (2026-07-23): avisa a dona de TODA location bloqueada por saldo.
 *
 * Motivação (scan lead-facing 07-23): 11 locations estavam bloqueadas e 9 donas
 * NUNCA foram avisadas — o `notifyWalletBlockOwnerOnce` só era chamado no
 * pipeline de LEAD (queue-processor), então location sem tráfego de lead ou
 * SparkBot-only ficava bloqueada em silêncio por dias. Aqui um cron percorre
 * TODAS as bloqueadas e dispara o aviso (a função já tem cooldown 24h + CAS +
 * resolução de dona, então re-chamar é idempotente e barato). Piso de 5min pós-
 * bloqueio pra dar tempo do clear automático (recarga) rodar antes — não avisa
 * quem recarregou na hora. Fail-soft. Chamado pelo cron de billing.
 */
export async function sweepNotifyBlockedOwners(): Promise<{ scanned: number }> {
  if (isDisabled()) return { scanned: 0 };
  try {
    const supabase = createAdminClient();
    const blockedBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const notifiedBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: blocked } = await supabase
      .from("locations")
      .select("location_id")
      .not("wallet_blocked_at", "is", null)
      .lt("wallet_blocked_at", blockedBefore)
      .or(`wallet_block_notified_at.is.null,wallet_block_notified_at.lt.${notifiedBefore}`)
      .limit(100);
    for (const b of blocked || []) {
      // notifyWalletBlockOwnerOnce se auto-protege (cooldown/CAS/owner) — só avisa
      // quem realmente falta. Serial pra não estourar rate do canal de entrega.
      await notifyWalletBlockOwnerOnce((b as { location_id: string }).location_id).catch(() => {});
    }
    return { scanned: (blocked || []).length };
  } catch (err) {
    console.warn("[wallet-block] sweepNotifyBlockedOwners falhou (não-fatal):", err);
    return { scanned: 0 };
  }
}
