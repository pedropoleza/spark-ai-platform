import OpenAI from "openai";
import type { AIResponse, AIProcessingResult } from "@/types/ai";
import { sanitizeAgentMessage } from "@/lib/ai/response-sanitizer";

const OPENAI_VISION_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"];
const CLAUDE_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"];

function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 1 });
}

async function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY não configurada. Adicione no Vercel para usar modelos Claude.");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: key, timeout: 30000, maxRetries: 1 });
}

export interface ImageInput {
  url?: string;
  base64DataUri?: string;
}

/**
 * Turn estruturado do histórico. Formato nativo que OpenAI/Claude entendem,
 * em vez de texto colado "LEAD: x\nAGENTE: y". Ganhos: qualidade semântica
 * (modelo entende turn boundaries), menos tokens (prefixos somem), e melhor
 * cache hit — turns passados são byte-exact estáveis, só o último muda.
 */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchemaFormat = { name: string; strict: boolean; schema: any };

interface ProcessMessageInput {
  systemPrompt: string;
  runtimeContext?: string;
  /**
   * Preferido: array estruturado de turns. Quando presente, tem precedência
   * sobre conversationHistory.
   */
  conversationMessages?: ConversationTurn[];
  /**
   * Fallback legado: histórico como string "LEAD: x\nAGENTE: y". Mantido
   * para follow-ups e endpoints de teste que passam string livre.
   */
  conversationHistory: string;
  newMessages: string;
  model: string;
  images?: ImageInput[];
  responseSchema?: JsonSchemaFormat;
  /**
   * Quantos turnos já aconteceram antes da mensagem atual. Quando > 0, o
   * pós-processador remove saudação/apresentação do início da resposta,
   * como garantia mecânica caso o modelo ignore a regra do prompt.
   */
  priorTurnCount?: number;
}

function isClaude(model: string): boolean {
  return CLAUDE_MODELS.some((m) => model.startsWith(m));
}

function supportsVision(model: string): boolean {
  if (isClaude(model)) return true;
  return OPENAI_VISION_MODELS.some((m) => model.startsWith(m));
}

function supportsStructuredOutputs(model: string): boolean {
  return model.startsWith("gpt-4o") || model.startsWith("gpt-4.1") || model.startsWith("gpt-5");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Constrói o texto da última user message: runtimeContext + newMessages.
 * (Sem "Histórico" porque turns anteriores vêm como messages estruturadas.)
 */
function buildCurrentUserText(input: ProcessMessageInput): string {
  const runtimeBlock = input.runtimeContext ? `${input.runtimeContext}\n\n` : "";
  return `${runtimeBlock}Nova mensagem do lead:\n${input.newMessages}`;
}

/**
 * Truncagem de turns: se exceder budget, descarta os mais antigos. Turns
 * estruturados permitem corte limpo em boundary de mensagem (nunca no meio).
 */
function trimTurns(turns: ConversationTurn[], maxChars: number): ConversationTurn[] {
  if (turns.length === 0) return turns;
  let total = turns.reduce((sum, t) => sum + t.content.length, 0);
  if (total <= maxChars) return turns;
  const result = [...turns];
  while (result.length > 0 && total > maxChars) {
    const removed = result.shift();
    if (removed) total -= removed.content.length;
  }
  return result;
}

export async function processWithAI(input: ProcessMessageInput): Promise<AIProcessingResult> {
  const startTime = Date.now();

  try {
    const systemTokens = estimateTokens(input.systemPrompt);
    const runtimeTokens = estimateTokens(input.runtimeContext || "");
    const newMsgTokens = estimateTokens(input.newMessages);
    const useStructured = Array.isArray(input.conversationMessages) && input.conversationMessages.length > 0;

    let conversationMessages: ConversationTurn[] | undefined = input.conversationMessages;
    let conversationHistory = input.conversationHistory;

    if (useStructured) {
      const historyChars = conversationMessages!.reduce((s, t) => s + t.content.length, 0);
      const historyTokens = estimateTokens(" ".repeat(historyChars));
      const totalEstimate = systemTokens + runtimeTokens + newMsgTokens + historyTokens;
      if (totalEstimate > 100000) {
        const available = Math.max(0, 100000 - systemTokens - runtimeTokens - newMsgTokens);
        conversationMessages = trimTurns(conversationMessages!, available * 4);
        console.warn(`[AI] Budget exceeded (~${totalEstimate}tok). Trimmed history to ${conversationMessages.length} turns.`);
      }
    } else {
      const historyTokens = estimateTokens(conversationHistory || "");
      const totalEstimate = systemTokens + runtimeTokens + newMsgTokens + historyTokens;
      if (totalEstimate > 100000) {
        const available = Math.max(0, 100000 - systemTokens - runtimeTokens - newMsgTokens);
        if (conversationHistory && conversationHistory.length > available * 4) {
          conversationHistory = conversationHistory.slice(-(available * 4));
          console.warn(`[AI] Budget exceeded (~${totalEstimate}tok). Truncated legacy history.`);
        }
      }
    }

    const currentUserText = buildCurrentUserText(input);
    // Fallback legado: histórico como string vai junto com a user message.
    const legacyText = useStructured
      ? currentUserText
      : `${input.runtimeContext ? `${input.runtimeContext}\n\n` : ""}Histórico da conversa:\n${conversationHistory || "Nenhum histórico anterior."}\n\nNova mensagem do lead:\n${input.newMessages}`;

    if (isClaude(input.model)) {
      return await processWithClaude(input, legacyText, currentUserText, conversationMessages, startTime);
    }
    return await processWithOpenAI(input, legacyText, currentUserText, conversationMessages, startTime);
  } catch (error) {
    return {
      success: false,
      response: null,
      error: error instanceof Error ? error.message : "Erro desconhecido",
      duration_ms: Date.now() - startTime,
    };
  }
}

// ===== OpenAI =====
async function processWithOpenAI(
  input: ProcessMessageInput,
  legacyText: string,
  currentUserText: string,
  conversationMessages: ConversationTurn[] | undefined,
  startTime: number,
): Promise<AIProcessingResult> {
  const hasImages = input.images && input.images.length > 0;
  const modelVision = supportsVision(input.model);
  const useStructured = Array.isArray(conversationMessages) && conversationMessages.length > 0;

  // Última user message (que pode conter imagens)
  let currentUserMessage: OpenAI.ChatCompletionMessageParam;
  const userText = useStructured ? currentUserText : legacyText;

  if (hasImages && modelVision) {
    const parts: OpenAI.ChatCompletionContentPart[] = [{ type: "text", text: userText }];
    for (const img of input.images!.slice(0, 4)) {
      const url = img.base64DataUri || img.url;
      if (url) parts.push({ type: "image_url", image_url: { url, detail: "auto" } });
    }
    currentUserMessage = { role: "user", content: parts };
  } else {
    let text = userText;
    if (hasImages && !modelVision) {
      text += "\n\n[O contato enviou imagem(ns) mas o modelo atual não suporta análise visual.]";
    }
    currentUserMessage = { role: "user", content: text };
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: input.systemPrompt },
  ];
  if (useStructured) {
    for (const turn of conversationMessages!) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push(currentUserMessage);

  const useStrictSchema = input.responseSchema && supportsStructuredOutputs(input.model);
  const responseFormat: OpenAI.ChatCompletionCreateParams["response_format"] = useStrictSchema
    ? { type: "json_schema", json_schema: input.responseSchema! }
    : { type: "json_object" };

  const completion = await getOpenAIClient().chat.completions.create({
    model: input.model,
    messages,
    temperature: 0.8,
    max_tokens: 2500,
    response_format: responseFormat,
    store: true,
  });

  const responseText = completion.choices[0]?.message?.content;
  if (!responseText) return { success: false, response: null, error: "Resposta vazia da OpenAI" };

  const cachedTokens = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return buildResult(
    responseText,
    completion.usage?.prompt_tokens,
    completion.usage?.completion_tokens,
    cachedTokens,
    startTime,
    Boolean(useStrictSchema),
    input.priorTurnCount,
  );
}

// ===== Claude (Anthropic) =====
async function processWithClaude(
  input: ProcessMessageInput,
  legacyText: string,
  currentUserText: string,
  conversationMessages: ConversationTurn[] | undefined,
  startTime: number,
): Promise<AIProcessingResult> {
  const client = await getAnthropicClient();
  const hasImages = input.images && input.images.length > 0;
  const useStructured = Array.isArray(conversationMessages) && conversationMessages.length > 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currentContent: any[] = [];
  if (hasImages) {
    for (const img of input.images!.slice(0, 4)) {
      if (img.base64DataUri) {
        const match = img.base64DataUri.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          currentContent.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
        }
      }
    }
  }
  currentContent.push({ type: "text", text: useStructured ? currentUserText : legacyText });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [];
  if (useStructured) {
    for (const turn of conversationMessages!) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: "user", content: currentContent });

  const response = await client.messages.create({
    model: input.model,
    max_tokens: 2500,
    system: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } } as any,
    ],
    messages,
    temperature: 0.8,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const responseText = textBlock && "text" in textBlock ? textBlock.text : "";
  if (!responseText) return { success: false, response: null, error: "Resposta vazia do Claude" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = response.usage as any;
  const cachedTokens = (usage?.cache_read_input_tokens ?? 0);
  return buildResult(
    responseText,
    response.usage?.input_tokens,
    response.usage?.output_tokens,
    cachedTokens,
    startTime,
    false,
    input.priorTurnCount,
  );
}

// ===== Parser compartilhado =====
function buildResult(
  responseText: string,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  cachedTokens: number,
  startTime: number,
  strictSchemaUsed: boolean,
  priorTurnCount: number | undefined,
): AIProcessingResult {
  let parsed = parseAIResponse(responseText);
  let parseFailed = false;
  if (!parsed) {
    console.error(`[AI] JSON parse failed (strictSchema=${strictSchemaUsed}). Raw: "${responseText.substring(0, 500)}"`);
    parseFailed = true;
    parsed = {
      message: "Desculpa, tive um problema técnico. Pode repetir?",
      should_send_message: true,
      actions: [],
      internal_notes: "",
      collected_data: {},
      conversation_status: "active",
    };
  }

  // Pós-processamento mecânico. SEMPRE roda:
  //   - Remoção de travessão ("—"/"–"): 100% dos turnos (incluindo o 1º)
  //   - Remoção de saudação/apresentação: só em turnos > 1
  // Garantia mecânica contra o modelo ignorar as regras do prompt.
  const before = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
  parsed.message = sanitizeAgentMessage(parsed.message, priorTurnCount);
  const after = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
  if (before !== after) {
    console.log(`[AI sanitize] turn=${(priorTurnCount ?? 0) + 1} before="${String(before).substring(0, 80)}" after="${String(after).substring(0, 80)}"`);
  }

  const duration = Date.now() - startTime;
  const cacheHitRatio = promptTokens && promptTokens > 0 ? cachedTokens / promptTokens : 0;

  if (promptTokens) {
    console.log(`[AI] tokens=${promptTokens}in/${completionTokens || 0}out cached=${cachedTokens} hit=${(cacheHitRatio * 100).toFixed(1)}% dur=${duration}ms schema=${strictSchemaUsed ? "strict" : "none"}`);
  }

  return {
    success: true,
    response: parsed,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    cache_hit_ratio: cacheHitRatio,
    duration_ms: duration,
    parse_failed: parseFailed,
  };
}

function parseAIResponse(text: string): AIResponse | null {
  try {
    let cleaned = text.trim();
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      cleaned = jsonMatch[1].trim();
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    }

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(cleaned);

    let message: string | string[] = "";
    const rawMsg = parsed.message || parsed.message_to_user || parsed.response;
    if (Array.isArray(rawMsg)) {
      const filtered = rawMsg.filter((m: unknown) => typeof m === "string" && (m as string).trim());
      message = filtered.length > 0 ? filtered : "Pode me contar mais?";
    } else if (typeof rawMsg === "string" && rawMsg.trim()) {
      message = rawMsg;
    } else {
      message = "Pode me contar mais?";
    }

    const rawCollected = parsed.collected_data || parsed.extracted_data || {};
    const collected_data: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawCollected)) {
      const val = String(v || "").trim();
      if (val && !val.toLowerCase().includes("nao coletado") && !val.toLowerCase().includes("not collected") && val !== "(pendente)" && val !== "null" && val !== "undefined") {
        collected_data[k] = val;
      }
    }

    return {
      message,
      should_send_message: true,
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      internal_notes: parsed.internal_notes || "",
      collected_data,
      conversation_status: parsed.conversation_status || "active",
    };
  } catch {
    return null;
  }
}
