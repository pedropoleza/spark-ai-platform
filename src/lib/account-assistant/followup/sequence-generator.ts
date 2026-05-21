/**
 * LLM gera sequência de follow-up (Pedro 2026-05-18).
 *
 * Claude Sonnet (qualidade > custo aqui — msgs vão pra cliente real).
 * Tom adaptive baseado em spam_risk + goal + summary da conversa.
 *
 * Prompt enxuto, regras claras anti-spam, output estrito JSON.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ConversationSummary, GeneratedSequence, SpamScoreResult, SequenceType } from "./types";

const SONNET_MODEL = "claude-sonnet-4-6-20250929";
const MAX_TOKENS = 1500;

interface GeneratorInput {
  rep_name?: string;
  contact_name: string | null;
  contact_first_name?: string | null;
  goal?: string;
  manual_context?: string;
  conversation_summary?: ConversationSummary;
  spam_score: SpamScoreResult;
  desired_length: number;          // 1-3, já clampado
  default_interval_hours: number;  // entre msgs
  tone_hint?: string;
  sequence_type: SequenceType;
}

const SYSTEM_PROMPT = `Você é o SparkBot, assistente de IA pra agentes de seguros usando Spark Leads.

Sua tarefa AGORA é gerar mensagens de follow-up para um lead/cliente, em nome do agente.

REGRAS INVIOLÁVEIS:
1. Mensagens em PT-BR (Brasil), salvo se contexto indicar inglês.
2. Curtas e humanas (40-90 palavras max por msg).
3. ZERO linguagem agressiva de venda ("aproveite", "última chance", "urgente!").
4. ZERO promessas em nome do agente ("vou te dar desconto", "fechamos por X").
5. ZERO informações inventadas (nomes de produtos, valores, prazos).
6. Tom CONSULTIVO e GENTIL, não insistente.
7. Se o contato pediu tempo (ex: "vou falar com marido"), referencia COM RESPEITO esse pedido.
8. Se risco médio/alto, REDUZA quantidade e suavize tom.
9. NÃO use "Olá" + nome formal; use "Oi {first_name}," ou "{first_name}," (informal-pro).
10. Pode usar UMA pergunta aberta no final pra convidar resposta.
11. Não use {first_name} literal — INTERPOLE direto com o primeiro nome.
12. Cada mensagem tem objetivo específico (msg 1: retomar, msg 2: oferecer ajuda, msg 3: encerrar com porta aberta).
13. EVITE o travessão (o tracinho longo) nas mensagens; soa robótico/AI. Use vírgula, ponto, parênteses ou reescreva a frase.

OUTPUT: JSON estrito, sem markdown:
{
  "messages": [
    { "position": 1, "text": "...", "tone_hint": "leve_consultivo", "offset_hours_from_first": 0 },
    { "position": 2, "text": "...", "tone_hint": "porta_aberta", "offset_hours_from_first": 48 }
  ],
  "inferred_goal": "Retomar conversa pós-pedido de tempo",
  "inferred_tone": "consultivo_leve",
  "rationale": "Risco baixo, contato engajado, 2 msgs com 48h entre"
}`;

export async function generateSequence(input: GeneratorInput): Promise<GeneratedSequence> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return fallbackSequence(input);
  }

  // Clamp desired_length pelo recomendado pelo spam score
  const length = Math.min(input.desired_length, input.spam_score.max_suggested_messages, 3);

  const contactFirstName =
    input.contact_first_name ||
    (input.contact_name ? input.contact_name.split(" ")[0] : "lead");

  const userBlocks: string[] = [];
  userBlocks.push(`Contato: ${input.contact_name || "(sem nome)"} — primeiro nome: ${contactFirstName}`);
  userBlocks.push(`Tipo de sequência: ${input.sequence_type}`);
  userBlocks.push(`Goal do rep: ${input.goal || "(não especificado — inferir do contexto)"}`);
  userBlocks.push(`Quantidade desejada: ${length} msg(s)`);
  userBlocks.push(`Intervalo padrão entre msgs: ${input.default_interval_hours}h`);
  userBlocks.push(`Spam risk: ${input.spam_score.risk} (score ${input.spam_score.score}/100)`);
  if (input.spam_score.flags.length > 0) {
    userBlocks.push(`Flags: ${input.spam_score.flags.join(", ")}`);
  }
  if (input.spam_score.rationale) {
    userBlocks.push(`Score rationale: ${input.spam_score.rationale}`);
  }
  if (input.tone_hint) {
    userBlocks.push(`Tom pedido pelo rep: ${input.tone_hint}`);
  }
  if (input.manual_context) {
    userBlocks.push(`Contexto manual fornecido pelo rep: ${input.manual_context}`);
  }
  if (input.conversation_summary?.has_conversation) {
    userBlocks.push(`\nResumo da conversa anterior:\n${input.conversation_summary.summary}`);
    if (input.conversation_summary.flags && input.conversation_summary.flags.length > 0) {
      userBlocks.push(`Flags conversa: ${input.conversation_summary.flags.join(", ")}`);
    }
  }

  const userPrompt = userBlocks.join("\n");

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = resp.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();

    const parsed = parseGeneratorOutput(text, length, input.default_interval_hours);
    if (parsed) return parsed;
  } catch (err) {
    console.warn(
      "[followup-generator] LLM falhou:",
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
  }

  return fallbackSequence(input);
}

function parseGeneratorOutput(
  raw: string,
  expectedLength: number,
  defaultIntervalHours: number,
): GeneratedSequence | null {
  // Tenta extrair JSON (LLM às vezes coloca em markdown)
  let cleaned = raw;
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1];

  try {
    const parsed = JSON.parse(cleaned) as {
      messages?: Array<{
        position?: number;
        text?: string;
        tone_hint?: string;
        offset_hours_from_first?: number;
      }>;
      inferred_goal?: string;
      inferred_tone?: string;
      rationale?: string;
    };

    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;

    const messages = parsed.messages
      .filter((m) => typeof m.text === "string" && m.text.trim().length > 5)
      .slice(0, expectedLength)
      .map((m, idx) => ({
        position: typeof m.position === "number" ? m.position : idx + 1,
        // Pedro 2026-05-21: strip de travessão (—/–) — soa robótico no follow-up.
        text: (m.text as string).trim().replace(/[—–]/g, "-"),
        tone_hint: m.tone_hint,
        offset_hours_from_first:
          typeof m.offset_hours_from_first === "number"
            ? m.offset_hours_from_first
            : idx * defaultIntervalHours,
      }));

    if (messages.length === 0) return null;

    return {
      messages,
      inferred_goal: parsed.inferred_goal,
      inferred_tone: parsed.inferred_tone,
      rationale: parsed.rationale,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback heurístico se LLM down. Genérico mas seguro.
 */
function fallbackSequence(input: GeneratorInput): GeneratedSequence {
  const firstName =
    input.contact_first_name ||
    (input.contact_name ? input.contact_name.split(" ")[0] : "");
  const length = Math.min(input.desired_length, input.spam_score.max_suggested_messages, 3);
  const goalRef = input.goal ? `sobre ${input.goal}` : "";

  const templates = [
    `Oi ${firstName}, tudo bem? Passando aqui só pra saber se você teve a chance de ver aquilo que conversamos ${goalRef}. Se preferir falar, é só me dizer.`,
    `Oi ${firstName}, sem pressa nenhuma — só não queria deixar isso se perder. Posso te ajudar com alguma dúvida antes de seguir?`,
    `Oi ${firstName}, vou deixar essa pendente pra você decidir no seu tempo. Quando quiser retomar, é só me chamar.`,
  ];

  const messages = templates.slice(0, length).map((text, idx) => ({
    position: idx + 1,
    text: text.trim(),
    tone_hint: idx === 0 ? "leve_consultivo" : idx === length - 1 ? "porta_aberta" : "intermediario",
    offset_hours_from_first: idx * input.default_interval_hours,
  }));

  return {
    messages,
    inferred_goal: input.goal,
    inferred_tone: "consultivo_leve_fallback",
    rationale: "Fallback heurístico — LLM indisponível",
  };
}
