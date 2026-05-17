/**
 * Silence Recovery (4.3 Pedro 2026-05-16).
 *
 * Caso Gustavo 2026-05-16: bot ficou 5h15min sem responder após "Cancela"
 * por crash silencioso. Quando voltou, agiu como se nada tivesse acontecido,
 * o que fez rep perguntar "Você está funcionando?". Sem reconhecer o gap,
 * UX fica esquisita.
 *
 * Esta module:
 *   1. Detecta gap >30min entre último turn DO BOT e msg atual do rep.
 *   2. Retorna bloco pro system prompt orientando bot a reconhecer e oferecer
 *      retomar de onde parou OU começar do zero.
 *
 * Heurística: comparar `created_at` da última msg `role='assistant'` com
 * `created_at` da msg atual `role='user'`. Se > 30min, ativa.
 */

export interface SilenceGapInfo {
  /** Gap em minutos entre último turn do bot e msg atual do rep */
  gap_minutes: number;
  /** Timestamp do último turn do bot (ISO) */
  last_bot_at: string;
  /** O que bot disse por último (snippet curto pra prompt). */
  last_bot_snippet: string | null;
  /** Tem ação pendente (ex: bot fez pergunta e não veio resposta clara antes do gap)? */
  bot_was_waiting: boolean;
}

/**
 * Detecta gap entre msgs. Recebe lista de mensagens (já lidas do DB, mais
 * antiga primeiro) e devolve info se gap >30min E último era do bot.
 *
 * Retorna null se:
 *   - Lista vazia ou só 1 msg
 *   - Última msg não é do bot
 *   - Gap <= 30min
 */
export interface MessageForSilenceCheck {
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export function detectSilenceGap(
  messages: MessageForSilenceCheck[],
  gapThresholdMinutes: number = 30,
): SilenceGapInfo | null {
  if (!messages || messages.length < 2) return null;

  // Última msg é do rep (acabou de chegar). Procura o último assistant.
  const lastIsUser = messages[messages.length - 1].role === "user";
  if (!lastIsUser) return null;
  const currentUserMsg = messages[messages.length - 1];
  let lastBotIdx = -1;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastBotIdx = i;
      break;
    }
  }
  if (lastBotIdx < 0) return null;

  const lastBot = messages[lastBotIdx];
  const gapMs =
    new Date(currentUserMsg.created_at).getTime() -
    new Date(lastBot.created_at).getTime();
  const gapMin = Math.floor(gapMs / (1000 * 60));
  if (gapMin < gapThresholdMinutes) return null;

  // Heurística: bot estava esperando se última msg dele continha "?" ou
  // expressão equivalente de pergunta.
  const text = lastBot.content || "";
  const wasWaiting =
    /\?/.test(text) ||
    /confirma|me passa|qual.*\?|prefere|escolhe|qual opção/i.test(text);

  return {
    gap_minutes: gapMin,
    last_bot_at: lastBot.created_at,
    last_bot_snippet: text.slice(0, 200),
    bot_was_waiting: wasWaiting,
  };
}

/**
 * Gera bloco pro system prompt orientando bot sobre o gap.
 */
export function renderSilenceRecoveryForPrompt(info: SilenceGapInfo): string {
  const hoursOrMin =
    info.gap_minutes >= 60
      ? `${Math.floor(info.gap_minutes / 60)}h${info.gap_minutes % 60 > 0 ? ` ${info.gap_minutes % 60}min` : ""}`
      : `${info.gap_minutes}min`;

  const lines: string[] = [];
  lines.push("# ⏰ SILENCE GAP DETECTADO (4.3 Pedro 2026-05-16)");
  lines.push("");
  lines.push(
    `O rep voltou após **${hoursOrMin} de silêncio** desde seu último turn. ` +
    `Isso pode indicar: (a) rep estava ocupado e quer retomar de onde parou, ` +
    `(b) rep desistiu daquele fluxo, (c) crash silencioso do bot.`,
  );
  lines.push("");
  if (info.bot_was_waiting) {
    lines.push(
      "**Você ESTAVA esperando uma resposta dele.** Seu último turn foi:",
    );
    lines.push(`> "${info.last_bot_snippet}"`);
    lines.push("");
    lines.push(
      "AÇÃO RECOMENDADA: ABRA esse turn reconhecendo o gap antes de processar a msg atual.",
    );
    lines.push("Exemplo: 'Voltei — vi que ficamos parados em XX. A msg que você mandou agora muda o caminho?'",);
    lines.push(
      "OU: 'E aí, voltou — última coisa foi *<resumo curto>*. Continuo de onde parei ou começamos do zero?'",
    );
  } else {
    lines.push(
      "**Seu último turn não estava esperando resposta** — pode ter sido informativo. " +
      "Processe a msg atual normalmente, mas se for útil mencione brevemente o gap " +
      "('beleza, voltou — recapitulo o que decidimos?').",
    );
  }
  lines.push("");
  lines.push(
    "NÃO finja que nada aconteceu (caso Gustavo: bot voltou frio depois de 5h e rep perguntou 'Você está funcionando?').",
  );
  return lines.join("\n");
}
