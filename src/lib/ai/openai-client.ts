import OpenAI from "openai";
import type { AIResponse, AIProcessingResult } from "@/types/ai";

const VISION_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"];

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000,
    maxRetries: 1,
  });
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

function supportsVision(model: string): boolean {
  return VISION_MODELS.some((m) => model.startsWith(m));
}

export async function processWithAI(input: ProcessMessageInput): Promise<AIProcessingResult> {
  const startTime = Date.now();

  try {
    const textContent = `Historico da conversa:
${input.conversationHistory || "Nenhum historico anterior."}

Novas mensagens do lead:
${input.newMessages}`;

    const hasImages = input.images && input.images.length > 0;
    const modelSupportsVision = supportsVision(input.model);

    let userMessage: OpenAI.ChatCompletionMessageParam;

    if (hasImages && modelSupportsVision) {
      const contentParts: OpenAI.ChatCompletionContentPart[] = [
        { type: "text", text: textContent },
      ];

      for (const img of input.images!.slice(0, 4)) {
        const imageUrl = img.base64DataUri || img.url;
        if (!imageUrl) continue;
        contentParts.push({
          type: "image_url",
          image_url: { url: imageUrl, detail: "auto" },
        });
      }

      userMessage = { role: "user" as const, content: contentParts };
    } else {
      let finalText = textContent;
      if (hasImages && !modelSupportsVision) {
        finalText += "\n\n[O contato enviou imagem(ns) mas o modelo atual nao suporta analise visual. Informe ao contato que voce nao consegue ver imagens.]";
      }
      userMessage = { role: "user" as const, content: finalText };
    }

    const completion = await getOpenAIClient().chat.completions.create({
      model: input.model,
      messages: [
        { role: "system", content: input.systemPrompt },
        userMessage,
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) {
      return { success: false, response: null, error: "Resposta vazia da OpenAI" };
    }

    const parsed = parseAIResponse(responseText);
    if (!parsed) {
      return {
        success: false,
        response: null,
        error: `Falha ao parsear resposta: ${responseText.substring(0, 200)}`,
      };
    }

    return {
      success: true,
      response: parsed,
      prompt_tokens: completion.usage?.prompt_tokens,
      completion_tokens: completion.usage?.completion_tokens,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      response: null,
      error: error instanceof Error ? error.message : "Erro desconhecido na OpenAI",
      duration_ms: Date.now() - startTime,
    };
  }
}

function parseAIResponse(text: string): AIResponse | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned);

    let message: string | string[] = "";
    const rawMsg = parsed.message || parsed.message_to_user;
    if (Array.isArray(rawMsg)) {
      message = rawMsg.filter((m: unknown) => typeof m === "string" && m.trim());
    } else {
      message = rawMsg || "";
    }

    return {
      message,
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      internal_notes: parsed.internal_notes || "",
      collected_data: parsed.collected_data || parsed.extracted_data || {},
      conversation_status: parsed.conversation_status || "active",
    };
  } catch {
    return null;
  }
}
