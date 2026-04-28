import OpenAI from "openai";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import { trackAndCharge } from "@/lib/billing/charge";

/**
 * Rolling summarization de histórico longo. Substitui os N turns mais antigos
 * por um único "summary turn" sintético, preservando os últimos WINDOW turns
 * na íntegra. Roda só quando cruza threshold — e o summary é cacheado em
 * conversation_state para não regenerar a cada mensagem.
 */

const TURNS_THRESHOLD = 25;       // acima disso, compacta
const KEEP_RECENT = 12;           // últimos N turns ficam intactos
const SUMMARY_MODEL = "gpt-4.1-nano";

export interface CompressedHistory {
  turns: ConversationTurn[];
  summary?: string;
  /** Quantidade original de turns absorvidos pelo summary. */
  coveredCount: number;
  /** true se o summary foi (re)gerado agora — caller deve persistir. */
  regenerated: boolean;
}

interface BillingContext {
  locationId: string;
  companyId: string;
  agentId: string;
  contactId?: string;
  usesCustomKey?: boolean;
}

interface CompressInput {
  turns: ConversationTurn[];
  /** Summary em cache (já cobre os primeiros N turns). */
  cachedSummary?: string | null;
  /** Quantos turns o summary em cache cobre. */
  cachedCoveredCount?: number | null;
  /** Opcional: passe pra cobrar o uso (P0 review 2026-04-28). */
  billing?: BillingContext;
}

export async function compressHistory(input: CompressInput): Promise<CompressedHistory> {
  const turns = input.turns;

  if (turns.length <= TURNS_THRESHOLD) {
    return { turns, coveredCount: 0, regenerated: false };
  }

  const cutoff = turns.length - KEEP_RECENT;
  const oldTurns = turns.slice(0, cutoff);
  const recentTurns = turns.slice(cutoff);

  // Reaproveita summary se ele já cobre todos os turns antigos atuais.
  // Quando o cutoff avança, precisamos regenerar.
  if (
    input.cachedSummary &&
    input.cachedCoveredCount &&
    input.cachedCoveredCount >= cutoff
  ) {
    return {
      turns: buildResult(input.cachedSummary, recentTurns),
      summary: input.cachedSummary,
      coveredCount: input.cachedCoveredCount,
      regenerated: false,
    };
  }

  // Gerar novo summary
  try {
    const summary = await summarizeTurns(oldTurns, input.cachedSummary || undefined, input.billing);
    return {
      turns: buildResult(summary, recentTurns),
      summary,
      coveredCount: cutoff,
      regenerated: true,
    };
  } catch (error) {
    console.error("[compressHistory] summarization failed, falling back to truncation:", error);
    // Fallback: truncar (comportamento legado)
    return { turns: recentTurns, coveredCount: 0, regenerated: false };
  }
}

function buildResult(summary: string, recentTurns: ConversationTurn[]): ConversationTurn[] {
  // Summary vai como um "user turn" sintético marcado claramente, seguido de
  // um "assistant turn" de ACK para não confundir o modelo sobre quem disse.
  return [
    {
      role: "user",
      content: `[CONTEXTO — resumo das mensagens anteriores]\n${summary}`,
    },
    {
      role: "assistant",
      content: "[Entendi o contexto. Continuando a conversa.]",
    },
    ...recentTurns,
  ];
}

async function summarizeTurns(
  turns: ConversationTurn[],
  priorSummary?: string,
  billing?: BillingContext,
): Promise<string> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 15000,
    maxRetries: 1,
  });

  const formatted = turns
    .map((t) => `${t.role === "user" ? "LEAD" : "AGENTE"}: ${t.content}`)
    .join("\n");

  const systemMsg = `Você é um condensador de contexto de conversa comercial via WhatsApp.
Receba a conversa abaixo e produza um resumo ENXUTO (máx 200 palavras) cobrindo:
- Dados pessoais mencionados (nome, estado, profissão, preferências)
- Perguntas/objeções do lead e como foram tratadas
- Compromissos, horários ou próximos passos combinados
- Tom/disposição do lead (interessado, hesitante, etc)

NÃO invente informação. Se algo não foi dito, não mencione.
Formato: parágrafos curtos ou bullets. Idioma: português.`;

  const userMsg = priorSummary
    ? `Resumo anterior (integre com as novas mensagens):\n${priorSummary}\n\n---\n\nNovas mensagens para incorporar:\n${formatted}`
    : `Conversa a resumir:\n${formatted}`;

  const completion = await client.chat.completions.create({
    model: SUMMARY_MODEL,
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    temperature: 0.3,
    max_tokens: 400,
    store: true,
  });

  const summary = completion.choices[0]?.message?.content?.trim();
  if (!summary) throw new Error("empty summary");

  // C3: cobrar o uso da compressão. Custo individual ~$0.0002/compress mas
  // disparado a cada vez que o cutoff avança em conversas longas.
  if (billing) {
    try {
      await trackAndCharge({
        locationId: billing.locationId,
        companyId: billing.companyId,
        agentId: billing.agentId,
        contactId: billing.contactId,
        actionType: "history_compression",
        model: SUMMARY_MODEL,
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
        cachedTokens: (completion.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
          ?.prompt_tokens_details?.cached_tokens ?? 0,
        usesCustomKey: billing.usesCustomKey ?? false,
      });
    } catch (e) {
      console.error("[compressHistory] billing failed (non-blocking):", e instanceof Error ? e.message : e);
    }
  }

  return summary;
}
