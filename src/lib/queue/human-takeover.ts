/**
 * Detecção de "humano assumiu a conversa" (handoff) — lógica compartilhada.
 *
 * Usada em dois pontos (DRY — antes a heurística anti-eco vivia inline só no
 * webhook e corria risco de divergir):
 *   1. Webhook /api/webhooks/inbound-message (branch outbound, tempo real) —
 *      depende do GHL assinar OutboundMessage (F51).
 *   2. queue-processor (fallback por histórico, F52) — funciona mesmo sem o
 *      webhook: ao processar um inbound, olha se a última msg outbound da
 *      conversa foi de um humano (não da IA) e pausa antes de responder.
 *
 * Como o GHLMessage não traz userId/source, distinguir "msg da IA" de "msg de
 * humano" é feito por ANTI-ECO: a mensagem bate com algo que a IA registrou ter
 * enviado (execution_log send_message)? Se não bate → humano.
 */

/** Normaliza pra comparação tolerante (colapsa espaços, lower-case). */
function normalize(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * `body` é eco de ALGUMA mensagem que a IA enviou?
 *
 * Match tolerante (fix ultra-review 2026-05-26): além de igualdade exata, aceita
 * prefixo/contém quando ambos têm ≥20 chars — o canal pode truncar, alterar
 * emoji ou anexar sufixo em trânsito, e só-exato gerava FALSO-POSITIVO de
 * "humano" (pausa indevida). <20 chars exige match exato (evita falso-eco curto).
 */
export function isAiEcho(body: string, aiMessages: string[]): boolean {
  const bodyNorm = normalize(body);
  if (!bodyNorm) return false;
  for (const ai of aiMessages) {
    const cn = normalize(ai);
    if (!cn) continue;
    if (cn === bodyNorm) return true;
    const shorter = Math.min(cn.length, bodyNorm.length);
    if (shorter < 20) continue;
    if (
      cn.startsWith(bodyNorm) ||
      bodyNorm.startsWith(cn) ||
      cn.includes(bodyNorm) ||
      bodyNorm.includes(cn)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extrai os textos que a IA enviou a partir de linhas de execution_log
 * (action_type='send_message'). O payload.message pode ser string ou string[].
 */
export function extractAiSentTexts(
  rows: Array<{ action_payload: unknown }> | null | undefined,
): string[] {
  const out: string[] = [];
  for (const row of rows || []) {
    const msg = (row?.action_payload as { message?: unknown } | null)?.message;
    if (Array.isArray(msg)) {
      out.push(...msg.filter((m): m is string => typeof m === "string"));
    } else if (typeof msg === "string") {
      out.push(msg);
    }
  }
  return out;
}
