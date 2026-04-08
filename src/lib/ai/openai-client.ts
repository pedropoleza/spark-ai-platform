import OpenAI from "openai";
import type { AIResponse, AIProcessingResult } from "@/types/ai";

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000, // 30s timeout
    maxRetries: 1,
  });
}

interface ProcessMessageInput {
  systemPrompt: string;
  conversationHistory: string;
  newMessages: string;
  model: string;
}

export async function processWithAI(input: ProcessMessageInput): Promise<AIProcessingResult> {
  const startTime = Date.now();

  try {
    const userContent = `Historico da conversa:
${input.conversationHistory || "Nenhum historico anterior."}

Novas mensagens do lead:
${input.newMessages}`;

    const completion = await getOpenAIClient().chat.completions.create({
      model: input.model,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) {
      return { success: false, response: null, error: "Resposta vazia da OpenAI" };
    }

    // Parse JSON da resposta
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
    // Remover markdown code blocks se presentes
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

    // Normalizar message (string ou array)
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
