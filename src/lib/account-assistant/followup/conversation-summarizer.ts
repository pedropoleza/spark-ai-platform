/**
 * Summarizer LLM da conversa pra contextualizar follow-up
 * (Pedro 2026-05-18).
 *
 * Usa Claude Haiku 4.5 (cheap, fast). Foco: estado atual, última coisa
 * discutida, compromissos pendentes, tom, objeções/hesitações.
 *
 * Falha gracefully — se LLM down, retorna summary heurístico simples.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ContextSignals } from "./context-resolver";
import type { ConversationSummary } from "./types";

const HAIKU_MODEL = "claude-haiku-4-5-20250929";
const MAX_SUMMARY_TOKENS = 400;

export async function summarizeConversation(
  signals: ContextSignals,
  goal: string | undefined,
): Promise<ConversationSummary> {
  if (!signals.has_conversation || signals.message_count === 0) {
    return {
      has_conversation: false,
      message_count: 0,
      last_inbound_at: null,
      last_outbound_at: null,
      unanswered_outbound_count: 0,
      inbound_outbound_ratio: 0,
      summary: "Sem histórico de conversa anterior — contato novo ou primeira interação.",
      flags: [],
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return heuristicSummary(signals);
  }

  const transcript = signals.messages
    .map((m) => `[${m.direction.toUpperCase()}] ${m.body.slice(0, 300)}`)
    .join("\n");

  const prompt = `Resuma essa conversa entre um rep de vendas e contato (lead/cliente) em ≤180 palavras.

Foque em:
- ESTADO ATUAL da negociação/relacionamento (frio, morno, quente)
- ÚLTIMA coisa discutida ou prometida
- COMPROMISSOS pendentes (rep prometeu algo? contato prometeu?)
- TOM da última resposta do contato (interessado, hesitante, frio, irritado)
- PONTOS SENSÍVEIS (objeções, dúvidas, hesitações, pedidos de tempo)

${goal ? `Goal do rep agora: "${goal}"\n` : ""}

Mensagens (ordem cronológica):
${transcript}

Responda APENAS o resumo em PT-BR (sem preâmbulo). 1-2 parágrafos curtos.`;

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: MAX_SUMMARY_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();

    // Flags simples extraídos do summary
    const flags: string[] = [];
    if (/falar com (marido|esposa|s[oó]cio|equipe)/i.test(text)) flags.push("contato pediu tempo pra decidir com terceiro");
    if (/n[ãa]o tenho interesse|n[ãa]o quero|parou de responder/i.test(text)) flags.push("sinal de desinteresse");
    if (/proposta enviada|proposta sent|enviei.*proposta/i.test(text)) flags.push("proposta em andamento");
    if (signals.unanswered_outbound_count >= 2) flags.push(`${signals.unanswered_outbound_count} msgs sem resposta`);

    return {
      has_conversation: true,
      message_count: signals.message_count,
      last_inbound_at: signals.last_inbound_at,
      last_outbound_at: signals.last_outbound_at,
      unanswered_outbound_count: signals.unanswered_outbound_count,
      inbound_outbound_ratio: signals.inbound_outbound_ratio,
      summary: text || "(LLM retornou vazio — usando heurística)",
      flags,
    };
  } catch (err) {
    console.warn(
      "[followup-summarizer] LLM falhou — fallback heurístico:",
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return heuristicSummary(signals);
  }
}

function heuristicSummary(signals: ContextSignals): ConversationSummary {
  const parts: string[] = [];
  parts.push(`${signals.message_count} msgs trocadas (${signals.inbound_count} in / ${signals.outbound_count} out).`);
  if (signals.last_inbound_at) {
    const d = signals.days_since_last_inbound ?? 0;
    parts.push(`Última resposta do contato há ${d} dia(s).`);
  } else {
    parts.push("Contato nunca respondeu.");
  }
  if (signals.unanswered_outbound_count > 0) {
    parts.push(`${signals.unanswered_outbound_count} msgs do rep sem resposta.`);
  }
  return {
    has_conversation: true,
    message_count: signals.message_count,
    last_inbound_at: signals.last_inbound_at,
    last_outbound_at: signals.last_outbound_at,
    unanswered_outbound_count: signals.unanswered_outbound_count,
    inbound_outbound_ratio: signals.inbound_outbound_ratio,
    summary: parts.join(" "),
    flags: signals.unanswered_outbound_count >= 2 ? [`${signals.unanswered_outbound_count} msgs sem resposta`] : [],
  };
}
