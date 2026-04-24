/**
 * LLM client com tool-calling. Claude Sonnet 4.6 como default (melhor em
 * tool use complexo), fallback automático pra GPT-4.1 se Claude falhar.
 *
 * Implementa loop multi-turn: se o modelo chama tool, executamos, retornamos
 * o resultado e rodamos de novo até o modelo parar de chamar tools ou
 * atingir maxIterations.
 */

import type { ToolDefinition } from "@/types/account-assistant";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const FALLBACK_MODEL = "gpt-4.1";
const MAX_ITERATIONS = 6;

async function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY não configurada.");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: key, timeout: 45000, maxRetries: 1 });
}

export interface LLMContentBlock {
  type: "text" | "image";
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
}

export interface LLMUserMessage {
  role: "user";
  content: string | LLMContentBlock[];
}

export interface LLMAssistantMessage {
  role: "assistant";
  content: string | LLMContentBlock[];
}

export type LLMMessage = LLMUserMessage | LLMAssistantMessage;

export interface ToolCallExecutor {
  (name: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface RunWithToolsInput {
  systemPrompt: string;
  messages: LLMMessage[]; // histórico + user message atual (com runtime context já incluso)
  tools: ToolDefinition[];
  executor: ToolCallExecutor;
  model?: string;
}

export interface RunWithToolsOutput {
  text: string;
  tool_calls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: unknown;
  }>;
  model_used: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  iterations: number;
  stopped_reason: "end_turn" | "max_iterations" | "error";
}

/**
 * Roda o loop multi-turn com Claude. Executa tools solicitadas, realimenta
 * resultado, continua até end_turn.
 */
export async function runWithTools(input: RunWithToolsInput): Promise<RunWithToolsOutput> {
  const model = input.model || DEFAULT_MODEL;
  try {
    return await runWithClaude({ ...input, model });
  } catch (err) {
    console.warn(
      `[LLM] Primary model ${model} failed, falling back to ${FALLBACK_MODEL}:`,
      err instanceof Error ? err.message : err,
    );
    // Fallback pra OpenAI se Anthropic falhou (rate limit, down, etc)
    // V1: fallback simplificado — apenas retorna erro pra UI tratar.
    // Futuro: implementar OpenAI tool use com mesmo formato.
    return {
      text: "Tive um problema técnico aqui. Pode tentar de novo em alguns segundos?",
      tool_calls: [],
      model_used: model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      iterations: 0,
      stopped_reason: "error",
    };
  }
}

// =====================================================
// Claude (Anthropic) implementation
// =====================================================

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

async function runWithClaude(input: RunWithToolsInput & { model: string }): Promise<RunWithToolsOutput> {
  const client = await getAnthropicClient();

  // Copia das messages em formato Anthropic (permite push sem mutar o input)
  const messages: AnthropicMessage[] = input.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : (m.content as AnthropicBlock[]),
  }));

  const tools = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const tool_calls: RunWithToolsOutput["tool_calls"] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: input.model,
      max_tokens: 2500,
      system: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } } as any,
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      temperature: 0.3, // mais determinístico pra tool use
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = response.usage as any;
    const freshInput = response.usage?.input_tokens || 0;
    const cachedInput = usage?.cache_read_input_tokens || 0;
    // Normalizar: prompt_tokens = total de input (fresh + cached), igual o
    // formato da OpenAI. Evita cache % > 100% quando UI divide cached/prompt.
    totalPromptTokens += freshInput + cachedInput;
    totalCompletionTokens += response.usage?.output_tokens || 0;
    totalCachedTokens += cachedInput;

    // Append response como assistant message
    messages.push({ role: "assistant", content: response.content as AnthropicBlock[] });

    // Se o modelo parou (não pediu mais tools), extrai texto final
    if (response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence") {
      const textBlocks = (response.content as AnthropicBlock[]).filter(
        (b): b is AnthropicTextBlock => b.type === "text",
      );
      const finalText = textBlocks.map((b) => b.text).join("\n").trim();
      return {
        text: finalText,
        tool_calls,
        model_used: input.model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        cached_tokens: totalCachedTokens,
        iterations: i + 1,
        stopped_reason: "end_turn",
      };
    }

    // stop_reason === "tool_use": execute todas as tool_use blocks
    const toolUses = (response.content as AnthropicBlock[]).filter(
      (b): b is AnthropicToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Stop reason estranho sem tool_use — trata como end
      const textBlocks = (response.content as AnthropicBlock[]).filter(
        (b): b is AnthropicTextBlock => b.type === "text",
      );
      const finalText = textBlocks.map((b) => b.text).join("\n").trim();
      return {
        text: finalText || "(sem resposta)",
        tool_calls,
        model_used: input.model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        cached_tokens: totalCachedTokens,
        iterations: i + 1,
        stopped_reason: "end_turn",
      };
    }

    const toolResults: AnthropicToolResultBlock[] = [];
    for (const tu of toolUses) {
      try {
        const result = await input.executor(tu.name, tu.input);
        tool_calls.push({ name: tu.name, input: tu.input, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "tool execution failed";
        tool_calls.push({
          name: tu.name,
          input: tu.input,
          result: { status: "error", message: errorMsg },
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ status: "error", message: errorMsg }),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Loop excedeu maxIterations
  return {
    text: "Executei várias ações mas preciso parar aqui. Me pede de novo se faltou algo.",
    tool_calls,
    model_used: input.model,
    prompt_tokens: totalPromptTokens,
    completion_tokens: totalCompletionTokens,
    cached_tokens: totalCachedTokens,
    iterations: MAX_ITERATIONS,
    stopped_reason: "max_iterations",
  };
}
