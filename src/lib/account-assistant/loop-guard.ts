/**
 * Loop-guard bot-a-bot (ultra-review 2026-07-17, P0 caso Fabiana).
 *
 * Caso real: o telefone do canal lead-facing da location foi identificado como
 * REP (identidade fantasma d23d0501) → proativo do SparkBot caía no agente
 * lead-facing, que auto-respondia como se fosse lead, e o SparkBot tratava a
 * resposta como rep → ping-pong IA×IA (112 msgs numa noite, cadência ~30s),
 * com o inbound do outro bot resetando o silence-gate — o loop nunca pausava
 * sozinho e chegou a executar ação real no CRM no meio.
 *
 * Detecção DETERMINÍSTICA (módulo puro, testável) sobre as últimas mensagens
 * da conversa do rep: humano de verdade não sustenta N trocas seguidas
 * respondendo em <90s com textos longos. Falso-positivo é raro e barato: o
 * processor silencia UM turno + pausa proativos + emite admin_signal; a
 * próxima mensagem do rep >90s depois volta ao fluxo normal.
 */

export interface LoopGuardMsg {
  /** "user" | "agent" (roles do sparkbot_messages) */
  role: string;
  /** ISO timestamp */
  created_at: string;
  /** tamanho do texto (chars) */
  content_len: number;
}

/** Trocas agent→user consecutivas no fim da conversa pra acusar loop. */
export const LOOP_MIN_EXCHANGES = 6;
/** Resposta do "rep" mais rápida que isso conta como cadência de bot. */
export const LOOP_MAX_REPLY_GAP_MS = 90_000;
/** Textos curtos ("sim", "ok") são humano apressado, não auto-reply de IA. */
export const LOOP_MIN_USER_LEN = 40;

/**
 * Conta, do FIM da conversa pra trás, as trocas em que uma msg do "rep" (user)
 * veio logo depois de uma msg do bot (agent) em <90s e com texto >=40 chars.
 * Bubbles múltiplas do agent entre trocas são toleradas; user atrás de user
 * (rajada humana de double-text) QUEBRA o padrão — bots do loop não fazem isso.
 *
 * @param msgsAsc mensagens em ordem CRONOLÓGICA (asc). A msg atual do turno
 *                (inbound recém-persistido) deve ser a última.
 * @param minExchanges override do mínimo de trocas (H52 review adversarial):
 *                     rep JÁ flagrado em loop (proactive_pause_source=
 *                     'loop_guard') usa 2 — depois do 1º flagra, o guard
 *                     re-silencia no 2º ping-pong em vez de deixar ~6 turnos
 *                     LLM queimarem a cada re-ignição (follow-up do outro bot).
 */
export function detectPingPongLoop(
  msgsAsc: LoopGuardMsg[],
  minExchanges: number = LOOP_MIN_EXCHANGES,
): {
  looping: boolean;
  exchanges: number;
} {
  let exchanges = 0;
  let idx = msgsAsc.length - 1;

  while (idx >= 1) {
    // pula bubbles do agent no fim da janela (ex: proativo ainda sem resposta)
    if (msgsAsc[idx].role !== "user") {
      idx--;
      continue;
    }
    const user = msgsAsc[idx];
    const prev = msgsAsc[idx - 1];
    if (prev.role !== "agent") break; // user atrás de user = humano em rajada
    const gap =
      new Date(user.created_at).getTime() - new Date(prev.created_at).getTime();
    if (
      !(gap >= 0 && gap < LOOP_MAX_REPLY_GAP_MS) ||
      user.content_len < LOOP_MIN_USER_LEN
    ) {
      break;
    }
    exchanges++;
    // pula as demais bubbles do agent desta troca e segue pra troca anterior
    let j = idx - 1;
    while (j >= 0 && msgsAsc[j].role === "agent") j--;
    idx = j;
  }

  return { looping: exchanges >= minExchanges, exchanges };
}
