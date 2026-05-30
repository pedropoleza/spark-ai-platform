/**
 * Should-Respond Decision Gate — F37 (Pedro 2026-05-29).
 *
 * Antes do queue-processor chamar o LLM, avalia se o bot DEVE responder ou
 * SILENCIAR (e talvez notificar o rep humano via SparkBot).
 *
 * Heurísticas (ordem de avaliação):
 *  1. **Humano respondeu recentemente** — última msg outbound era de pessoa
 *     (source != "api") dentro da janela configurada → SKIP + notify rep.
 *     Evita bot atropelar conversa que o rep está conduzindo.
 *  2. **Lead pediu humano explicitamente** — regex em
 *     custom_keywords_handoff matched na msg atual → SKIP + notify rep.
 *  3. **Opp em status fechado** — won/lost/abandoned → SKIP silently.
 *     Não precisa notificar — lead já tem destino definido.
 *  4. **Default** — RESPOND.
 *
 * Fail-soft: se a policy não tem `enabled`, sempre responde (retrocompat).
 */
import type {
  HandoffPolicy,
  LeadContext,
  ShouldRespondDecision,
} from "@/types/agent";

const MIN_RECENT_MSG_HEURISTIC = 1; // pelo menos 1 msg pra checar
const NORM = (s: string) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

/** Minutos entre 2 timestamps ISO. */
function minutesBetween(isoA: string, isoB: string): number {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(b - a) / 60_000;
}

/**
 * Avalia se o bot deve responder.
 *
 * @param leadContext snapshot do GHL (ou EMPTY se loader falhou)
 * @param currentMessageBody texto da msg atual do lead (pra match keywords)
 * @param policy config do agente
 * @param now timestamp atual (default Date.now ISO)
 */
export function evaluateShouldRespond(
  leadContext: LeadContext,
  currentMessageBody: string,
  policy: HandoffPolicy,
  now: string = new Date().toISOString(),
): ShouldRespondDecision {
  if (!policy.enabled) {
    return { decision: "respond" };
  }

  // 1. Humano respondeu recentemente
  if (leadContext.last_human_outbound_at && policy.skip_if_human_replied_within_minutes > 0) {
    const mins = minutesBetween(leadContext.last_human_outbound_at, now);
    if (mins <= policy.skip_if_human_replied_within_minutes) {
      return {
        decision: "skip",
        reason: `human_replied_recently:${Math.round(mins)}min`,
        notify_rep: policy.notify_rep_via_sparkbot,
        suggested_action: `O rep respondeu há ${Math.round(mins)} min. Aguardando ele continuar.`,
      };
    }
  }

  // 2. Lead pediu humano (regex)
  if (policy.skip_if_lead_requested_human && currentMessageBody) {
    const bodyNorm = NORM(currentMessageBody);
    const keywords = (policy.custom_keywords_handoff || []).map(NORM).filter(Boolean);
    const matched = keywords.find((k) => bodyNorm.includes(k));
    if (matched) {
      return {
        decision: "skip",
        reason: `lead_requested_human:"${matched}"`,
        notify_rep: policy.notify_rep_via_sparkbot,
        suggested_action: `Lead pediu falar com humano ("${matched}"). Vai responder?`,
      };
    }
  }

  // 3. Opp em status fechado
  if (policy.notify_on_opp_stage_closed && leadContext.has_closed_opp) {
    const closedOpp = leadContext.opportunities.find((o) =>
      ["won", "lost", "abandoned"].includes((o.status || "").toLowerCase()),
    );
    return {
      decision: "skip",
      reason: `opp_closed:${closedOpp?.status || "unknown"}`,
      notify_rep: false, // silently — lead já tem destino
    };
  }

  // 4. Default
  return { decision: "respond" };
}

/** Util: leadContext sem msgs/opps válidas → falsa-segurança. */
export function hasUsefulHistory(ctx: LeadContext): boolean {
  return (
    ctx.recent_messages.length >= MIN_RECENT_MSG_HEURISTIC ||
    ctx.opportunities.length > 0 ||
    ctx.notes.length > 0
  );
}
