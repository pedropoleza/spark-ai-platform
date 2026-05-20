/**
 * Lógica PURA do debounce de rajada (Pedro 2026-05-20). Separada do
 * stevo-handler pra ser testável sem DB/sleep.
 *
 * Contexto: o rep manda em rajada no WhatsApp ("+number marca sexta" / "client
 * calendar"). Sem debounce, cada msg virava uma resposta fragmentada. A janela
 * de espera + "latest-wins" fica no handler (faz I/O); aqui só a parte pura:
 * dado o histórico cronológico (que TERMINA na msg atual) + se é texto, decide
 * o INPUT do turno e o HISTÓRICO a passar pro LLM.
 *
 *   - Texto: combina a "rajada não-respondida" (run de msgs `user` no fim) num
 *     turno só e tira ela do histórico (senão duplica).
 *   - Mídia: tira só a msg atual (a última) do histórico; input = a mídia. O
 *     texto anterior não-respondido FICA no histórico (LLM vê o contexto).
 */

import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";

export interface ChronoMessage {
  role: string; // "user" | "agent" | "assistant"
  content: string;
}

/**
 * @param chrono   Histórico em ordem CRONOLÓGICA, terminando na msg atual.
 * @param isTextLike  true se a msg atual é texto/interativo (combina rajada).
 * @param fallbackInput  RepInput da msg atual (usado p/ mídia ou rajada de 1).
 */
export function resolveBurstTurn(
  chrono: ChronoMessage[],
  isTextLike: boolean,
  fallbackInput: RepInput,
): { input: RepInput; history: ConversationTurn[] } {
  let priorHistory: ChronoMessage[] = chrono;
  let input: RepInput = fallbackInput;

  if (isTextLike) {
    // run de mensagens 'user' no FIM = rajada não-respondida desde a última
    // mensagem do agente.
    let splitIdx = chrono.length;
    for (let i = chrono.length - 1; i >= 0; i--) {
      if (chrono[i].role === "user") splitIdx = i;
      else break;
    }
    const batch = chrono.slice(splitIdx);
    priorHistory = chrono.slice(0, splitIdx);
    if (batch.length > 1) {
      const combined = batch
        .map((m) => m.content)
        .join("\n")
        .trim();
      if (combined) input = { kind: "text", text: combined };
    }
  } else {
    // mídia: histórico exclui só a msg atual (a última).
    priorHistory = chrono.slice(0, -1);
  }

  const history: ConversationTurn[] = priorHistory.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  return { input, history };
}
