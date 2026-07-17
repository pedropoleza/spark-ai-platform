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

const SUPPORT_PHONE = "+1 (786) 771-7077";

/** Resposta determinística pro REP quando a location dele está sem saldo. */
export const WALLET_BLOCKED_REP_MESSAGE =
  "⚠️ Os créditos de IA desta conta acabaram, então precisei pausar por aqui. " +
  "Pra reativar, é só adicionar saldo na wallet do Spark Leads. " +
  `Qualquer dúvida, chama o suporte: ${SUPPORT_PHONE} 👍`;

/** Aviso (1x/24h) pra dona da conta quando os agentes lead-facing param. */
export const WALLET_BLOCKED_OWNER_MESSAGE =
  "⚠️ Os créditos de IA da conta acabaram — pausei o SparkBot e os agentes de IA " +
  "(os leads não estão recebendo resposta automática). Pra reativar: adicionar " +
  `saldo na wallet do Spark Leads. Dúvidas, chama o suporte: ${SUPPORT_PHONE}`;

/** Detecta o 400 de saldo do GHL sem acoplar no corpo exato do erro. */
export function isInsufficientFundsError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /insufficient\s+funds/i.test(msg);
}

function isDisabled(): boolean {
  return process.env.WALLET_BLOCK_DISABLED === "1";
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
      .select("wallet_blocked_at")
      .eq("location_id", locationId)
      .maybeSingle();
    const blockedAt = (loc?.wallet_blocked_at as string | null | undefined) || null;
    if (!blockedAt) {
      cache.set(locationId, { blocked: false, at: Date.now() });
      return;
    }
    const { data: updated } = await supabase
      .from("locations")
      .update({
        wallet_blocked_at: null,
        wallet_block_notified_at: null,
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
    // H52 R2: a janela começa 90s APÓS o bloqueio — o cache de 60s do gate
    // pode ter deixado msgs logo-pós-bloqueio serem RESPONDIDAS normalmente;
    // re-enfileirá-las geraria resposta/ação em dobro dias depois.
    const sinceIso = new Date(new Date(blockedAtIso).getTime() + 90_000).toISOString();
    const { data: skips } = await supabase
      .from("execution_log")
      .select("agent_id, contact_id")
      .eq("location_id", locationId)
      .eq("action_type", "wallet_blocked_skip")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(200);
    const pairs = new Map<string, { agentId: string; contactId: string }>();
    for (const s of skips || []) {
      const a = (s as { agent_id?: string }).agent_id;
      const c = (s as { contact_id?: string }).contact_id;
      if (a && c) pairs.set(`${a}|${c}`, { agentId: a, contactId: c });
    }
    if (pairs.size === 0) return;
    if (pairs.size > 50) {
      console.warn(
        `[wallet-block] ${pairs.size} conversas engolidas no bloqueio da ${locationId} — re-enfileirando as 50 mais recentes (cap).`,
      );
    }
    const { reenqueueInboundsSincePause } = await import("@/lib/queue/resume-reenqueue");
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
      const r = await reenqueueInboundsSincePause(supabase, {
        agentId: p.agentId,
        contactId: p.contactId,
        pausedSince: sinceIso,
        pausedReason: "wallet_blocked",
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
    const prevNotifiedAt = (loc.wallet_block_notified_at as string | null) || null;
    const last = prevNotifiedAt ? new Date(prevNotifiedAt).getTime() : 0;
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
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
    // o aviso (o vencedor envia).
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
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
