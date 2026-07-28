/**
 * Gate de silêncio no inbound lead-facing (MC-9, review Marcia 2026-07-28).
 *
 * Por que existe: o motor lead-facing OBRIGAVA resposta em 100% dos turnos —
 * o parser hardcodava should_send_message:true (destruindo o valor emitido
 * pelo modelo), mensagem vazia era reescrita pra "Pode me contar mais?" em
 * DUAS redes empilhadas (parser + executor), e o prompt mandava "SEMPRE true".
 * Resultado: 9,6% dos inbounds da conta Marcia eram acks puros ("ok/obrigada/
 * 👍") que forçavam turno LLM pago + resposta — a queixa de "empilhamento" da
 * dona ("a última msg tem que ficar, não precisa mandar outra").
 *
 * Design (opt-in por agente via agent_configs.allow_silent_turns, default
 * false = comportamento idêntico ao legado):
 *  - Silêncio SÓ com sinal EXPLÍCITO do modelo: should_send_message:false OU
 *    marcador [[NAO_ENVIAR]] no texto. Vazio ACIDENTAL nunca vira silêncio
 *    (cai nas redes de fallback de sempre).
 *  - Overrides determinísticos fail-open-pra-FALAR: 1º turno SEMPRE responde;
 *    inbound com pergunta ("?") SEMPRE responde.
 *  - Silêncio suprime SÓ o envio — actions (tag/book/update), billing e estado
 *    rodam normalmente no executor.
 *  - stripSilenceMarker roda INCONDICIONALMENTE no executor (mesmo com o gate
 *    OFF): o marcador só existia no fluxo de follow-up e não tinha strip em
 *    NENHUM caminho do inbound — se o modelo o emitisse, ia CRU pro lead.
 */

export const SILENCE_MARKER_RE = /\[\[\s*N[AÃ]O_ENVIAR\s*\]\]/gi;

export interface LeadSilenceInput {
  shouldSendMessage: boolean;
  /** message do response (string ou string[]) — buscamos o marcador aqui. */
  message: string | string[];
  /** Texto do inbound agregado do turno (pra override de pergunta). */
  inboundText: string;
  /** Turnos anteriores da conversa (0 = primeira mensagem do lead). */
  priorTurnCount: number;
  /** agent_configs.allow_silent_turns — false = gate desligado (legado). */
  allowSilence: boolean;
}

export interface LeadSilenceDecision {
  silent: boolean;
  via: "flag" | "marker" | null;
  /** Override que FORÇOU resposta apesar do sinal de silêncio (auditoria). */
  overridden: "first_turn" | "lead_question" | null;
}

function messageHasMarker(message: string | string[]): boolean {
  const parts = Array.isArray(message) ? message : [message];
  return parts.some((m) => {
    SILENCE_MARKER_RE.lastIndex = 0;
    return SILENCE_MARKER_RE.test(String(m ?? ""));
  });
}

export function evaluateLeadSilence(input: LeadSilenceInput): LeadSilenceDecision {
  if (!input.allowSilence) return { silent: false, via: null, overridden: null };

  const viaFlag = input.shouldSendMessage === false;
  const viaMarker = messageHasMarker(input.message);
  if (!viaFlag && !viaMarker) return { silent: false, via: null, overridden: null };
  const via = viaFlag ? "flag" : "marker";

  // Overrides fail-open-pra-falar: nunca deixar lead sem resposta onde importa.
  if (input.priorTurnCount <= 0) {
    return { silent: false, via, overridden: "first_turn" };
  }
  if (String(input.inboundText || "").includes("?")) {
    return { silent: false, via, overridden: "lead_question" };
  }
  return { silent: true, via, overridden: null };
}

/**
 * Remove o marcador de QUALQUER mensagem outbound (incondicional — roda mesmo
 * com o gate OFF e em turnos não-silenciosos). Partes que ficarem vazias após
 * o strip são descartadas.
 */
export function stripSilenceMarker(message: string | string[]): string | string[] {
  if (Array.isArray(message)) {
    const cleaned = message
      .map((m) => String(m ?? "").replace(SILENCE_MARKER_RE, "").trim())
      .filter((m) => m.length > 0);
    return cleaned;
  }
  return String(message ?? "").replace(SILENCE_MARKER_RE, "").trim();
}
