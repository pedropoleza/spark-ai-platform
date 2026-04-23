import OpenAI from "openai";
import type { AIResponse, AIProcessingResult } from "@/types/ai";

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

interface ProcessMessageInput {
  systemPrompt: string;
  conversationHistory: string;
  newMessages: string;
  model: string;
  images?: ImageInput[];
}

function isClaude(model: string): boolean {
  return CLAUDE_MODELS.some((m) => model.startsWith(m));
}

function supportsVision(model: string): boolean {
  if (isClaude(model)) return true;
  return OPENAI_VISION_MODELS.some((m) => model.startsWith(m));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function processWithAI(input: ProcessMessageInput): Promise<AIProcessingResult> {
  const startTime = Date.now();

  try {
    let conversationHistory = input.conversationHistory;
    const systemTokens = estimateTokens(input.systemPrompt);
    const newMsgTokens = estimateTokens(input.newMessages);
    const historyTokens = estimateTokens(conversationHistory || "");
    const totalEstimate = systemTokens + newMsgTokens + historyTokens;

    if (totalEstimate > 100000) {
      console.warn(`[AI] Token budget exceeded (~${totalEstimate}). Truncating history.`);
      const available = Math.max(0, 100000 - systemTokens - newMsgTokens);
      if (conversationHistory && conversationHistory.length > available * 4) {
        conversationHistory = conversationHistory.slice(-(available * 4));
      }
    }

    const textContent = `Histórico da conversa:
${conversationHistory || "Nenhum histórico anterior."}

Nova mensagem do lead:
${input.newMessages}`;

    if (isClaude(input.model)) {
      return await processWithClaude(input, textContent, startTime);
    }
    return await processWithOpenAI(input, textContent, startTime);
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
  input: ProcessMessageInput, textContent: string, startTime: number
): Promise<AIProcessingResult> {
  const hasImages = input.images && input.images.length > 0;
  const modelVision = supportsVision(input.model);

  let userMessage: OpenAI.ChatCompletionMessageParam;

  if (hasImages && modelVision) {
    const parts: OpenAI.ChatCompletionContentPart[] = [{ type: "text", text: textContent }];
    for (const img of input.images!.slice(0, 4)) {
      const url = img.base64DataUri || img.url;
      if (url) parts.push({ type: "image_url", image_url: { url, detail: "auto" } });
    }
    userMessage = { role: "user", content: parts };
  } else {
    let text = textContent;
    if (hasImages && !modelVision) {
      text += "\n\n[O contato enviou imagem(ns) mas o modelo atual não suporta análise visual.]";
    }
    userMessage = { role: "user", content: text };
  }

  const completion = await getOpenAIClient().chat.completions.create({
    model: input.model,
    messages: [{ role: "system", content: input.systemPrompt }, userMessage],
    temperature: 0.8,
    max_tokens: 2500,
    response_format: { type: "json_object" },
  });

  const responseText = completion.choices[0]?.message?.content;
  if (!responseText) return { success: false, response: null, error: "Resposta vazia da OpenAI" };

  return buildResult(responseText, completion.usage?.prompt_tokens, completion.usage?.completion_tokens, startTime);
}

// ===== Claude (Anthropic) =====
async function processWithClaude(
  input: ProcessMessageInput, textContent: string, startTime: number
): Promise<AIProcessingResult> {
  const client = await getAnthropicClient();
  const hasImages = input.images && input.images.length > 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contentBlocks: any[] = [];

  if (hasImages) {
    for (const img of input.images!.slice(0, 4)) {
      if (img.base64DataUri) {
        const match = img.base64DataUri.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          contentBlocks.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
        }
      }
    }
  }

  contentBlocks.push({ type: "text", text: textContent });

  const response = await client.messages.create({
    model: input.model,
    max_tokens: 2500,
    system: input.systemPrompt,
    messages: [{ role: "user", content: contentBlocks }],
    temperature: 0.8,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const responseText = textBlock && "text" in textBlock ? textBlock.text : "";
  if (!responseText) return { success: false, response: null, error: "Resposta vazia do Claude" };

  return buildResult(responseText, response.usage?.input_tokens, response.usage?.output_tokens, startTime);
}

// ===== Parser compartilhado =====
function buildResult(
  responseText: string,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  startTime: number
): AIProcessingResult {
  let parsed = parseAIResponse(responseText);
  if (!parsed) {
    console.error(`[AI] JSON parse failed. Raw: "${responseText.substring(0, 500)}"`);
    parsed = {
      message: "Desculpa, tive um problema técnico. Pode repetir?",
      should_send_message: true,
      actions: [],
      internal_notes: "",
      collected_data: {},
      conversation_status: "active",
    };
  }

  return {
    success: true,
    response: parsed,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    duration_ms: Date.now() - startTime,
  };
}

function parseAIResponse(text: string): AIResponse | null {
  try {
    let cleaned = text.trim();
    // Extrair JSON de markdown code blocks
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      cleaned = jsonMatch[1].trim();
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    }

    // Claude às vezes retorna texto antes do JSON — encontrar o primeiro {
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
