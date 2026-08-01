/**
 * Detecção da mensagem sintética de contexto de anúncio (CTWA) — H61.
 *
 * Fix bug observado em prod 2026-08-01 (caso Five Star/Marcia): lead que clica
 * em anúncio IG/FB chega com a mensagem que o gateway compõe no clique —
 * `📢 Veio de anúncio (instagram): "…"\n<url>\n\n<texto pré-preenchido>` — sem
 * ter digitado nada. Nas contas onde um workflow de boas-vindas já faz o 1º
 * toque, a IA respondia a explicação completa EM CIMA do bloco da equipe.
 * O queue-processor usa este helper pra marcar o turno como "só o clique"
 * (gate opt-in `agent_configs.suppress_ad_context_turn`, migration 00130).
 *
 * PURO, sem I/O. Match no INÍCIO do body; emoji opcional por robustez.
 */

export const AD_CONTEXT_BODY_RE = /^\s*(?:📢\s*)?Veio de an[uú]ncio\s*[(:]/iu;

export function isAdContextBody(body: string): boolean {
  return AD_CONTEXT_BODY_RE.test(String(body ?? ""));
}
