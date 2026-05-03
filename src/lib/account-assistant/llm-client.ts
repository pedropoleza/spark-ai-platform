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

// H1 (review 2026-04-28): no stress test, 6 de 7 falhas conversacionais
// (hallucinations, compliance flexível) ocorreram em GPT-4.1 fallback —
// nenhuma em Claude. Pra Sparkbot, queries de compliance/UW/produto NLG
// pedem comportamento conservador.
//
// Em vez de fallback agressivo na primeira falha de Claude, agora:
//   1) Anthropic SDK maxRetries=3 internamente (rate-limit, 5xx)
//   2) Se Anthropic ainda falhar, tentamos novamente com Haiku (mesmo
//      provider, mais barato + diferente capacity pool da Anthropic)
//   3) Só caímos pra OpenAI em failure terminal — e logamos como ERROR
//      pra Pedro investigar (não warn).
//
// Setting de env STRICT_CLAUDE_ONLY=1 desativa fallback OpenAI por completo
// (testes mostraram que OpenAI fallback é fonte de regressões em compliance).
const SECONDARY_CLAUDE_MODEL = "claude-haiku-4-5";
const STRICT_CLAUDE_ONLY = process.env.STRICT_CLAUDE_ONLY === "1";

// Cap defensivo no payload de tool result que vai pro LLM. Tools tipo
// get_conversation_history podem retornar MB se conversa for longa,
// estourando context window silenciosamente.
//
// H9 (review 2026-04-28): truncamos preservando HEAD + TAIL — antes
// truncávamos só o final, exatamente onde get_conversation_history retorna
// as msgs MAIS RECENTES. Pre-meeting briefing (system-rules.ts:36-43) usa
// essa tool e estava recebendo dados truncados sem saber.
const MAX_TOOL_RESULT_CHARS = 12000;

function truncateToolResult(serialized: string): string {
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serialized;
  const half = Math.floor((MAX_TOOL_RESULT_CHARS - 200) / 2);
  const head = serialized.slice(0, half);
  const tail = serialized.slice(-half);
  const omitted = serialized.length - head.length - tail.length;
  return `${head}\n\n[TRUNCATED: ${omitted} chars do MEIO omitidos pra preservar início + fim. Considere refinar filtro/limit pra obter dados completos.]\n\n${tail}`;
}

async function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY não configurada.");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: key, timeout: 60000, maxRetries: 3 });
}

/**
 * Erro especial: LLM falhou DEPOIS de já ter executado tools com side-effects.
 * NÃO deve cair em fallback (provider secundário re-executaria as tools).
 *
 * Fix CRITICAL stress test 2026-05-03: antes, Claude falhava em iteration 3
 * (depois de já ter chamado send_message_to_contact em iteration 1) → catch
 * recomeçava com Haiku do zero → Haiku re-chamava send_message → DOUBLE SEND.
 */
export class LLMFailureMidLoop extends Error {
  constructor(
    public iterationsCompleted: number,
    public partialResult: Partial<RunWithToolsOutput>,
    cause: Error,
  ) {
    super(`LLM provider failed at iteration ${iterationsCompleted} after ${partialResult.tool_calls?.length || 0} tool calls (no fallback): ${cause.message}`);
    this.name = "LLMFailureMidLoop";
  }
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
  /** Erro do modelo primário, se houve fallback. Ajuda debug Claude vs OpenAI. */
  primary_error?: string;
  /** Erro do secundário Claude, se também falhou e caiu pra OpenAI. */
  secondary_error?: string;
}

/**
 * Roda o loop multi-turn com Claude. Se falhar (rate limit, API down,
 * timeout), tenta OpenAI tool use com o mesmo loop iterativo.
 *
 * Pra Claude usar fallback OpenAI: input.model deve ser claude-*. Se já
 * é OpenAI, sem fallback (não vamos cair pro Claude — que se Claude tá
 * fora, OpenAI deve estar OK).
 */
export async function runWithTools(input: RunWithToolsInput): Promise<RunWithToolsOutput> {
  const model = input.model || DEFAULT_MODEL;
  const isClaude = model.startsWith("claude-");

  if (isClaude) {
    try {
      return await runWithClaude({ ...input, model });
    } catch (err) {
      // Fix CRITICAL: LLMFailureMidLoop = falhou DEPOIS de tools terem rodado.
      // NÃO fazer fallback pra outro provider (re-executaria side-effects).
      if (err instanceof LLMFailureMidLoop) {
        const errMsg = err.cause instanceof Error ? err.cause.message : String(err);
        console.error(`[LLM] Claude falhou após ${err.partialResult.tool_calls?.length || 0} tools — sem fallback: ${err.message}`);
        return {
          text: "Tive um problema técnico depois de iniciar algumas ações. Pode confirmar o que foi feito antes de tentar de novo? (algumas tools podem ter rodado com sucesso, outras não)",
          tool_calls: err.partialResult.tool_calls || [],
          model_used: err.partialResult.model_used || model,
          prompt_tokens: err.partialResult.prompt_tokens || 0,
          completion_tokens: err.partialResult.completion_tokens || 0,
          cached_tokens: err.partialResult.cached_tokens || 0,
          iterations: err.partialResult.iterations || 0,
          stopped_reason: "error" as const,
          primary_error: errMsg,
        };
      }

      const primaryErrMsg = err instanceof Error ? err.message : String(err);
      // H1: tenta secundário Anthropic antes de cair pra OpenAI. Diferente
      // capacity pool, mesmo comportamento conservador em compliance/UW.
      console.error(
        `[LLM] Claude primário (${model}) falhou (iteration 0, sem tools), tentando ${SECONDARY_CLAUDE_MODEL}: ${primaryErrMsg}`,
      );
      try {
        const r = await runWithClaude({ ...input, model: SECONDARY_CLAUDE_MODEL });
        return { ...r, primary_error: primaryErrMsg };
      } catch (err2) {
        // Mesmo guard pro secundário
        if (err2 instanceof LLMFailureMidLoop) {
          const errMsg = err2.cause instanceof Error ? err2.cause.message : String(err2);
          console.error(`[LLM] Haiku falhou após ${err2.partialResult.tool_calls?.length || 0} tools — sem fallback: ${err2.message}`);
          return {
            text: "Tive um problema técnico depois de iniciar algumas ações. Pode confirmar o que foi feito antes de tentar de novo?",
            tool_calls: err2.partialResult.tool_calls || [],
            model_used: err2.partialResult.model_used || SECONDARY_CLAUDE_MODEL,
            prompt_tokens: err2.partialResult.prompt_tokens || 0,
            completion_tokens: err2.partialResult.completion_tokens || 0,
            cached_tokens: err2.partialResult.cached_tokens || 0,
            iterations: err2.partialResult.iterations || 0,
            stopped_reason: "error" as const,
            primary_error: primaryErrMsg,
            secondary_error: errMsg,
          };
        }
        const secondaryErrMsg = err2 instanceof Error ? err2.message : String(err2);
        if (STRICT_CLAUDE_ONLY) {
          console.error(
            `[LLM] STRICT_CLAUDE_ONLY=1 — não cai pra OpenAI. Erro Claude secundário: ${secondaryErrMsg}`,
          );
          return { ...llmFailureStub(model), primary_error: primaryErrMsg, secondary_error: secondaryErrMsg };
        }
        console.error(
          `[LLM] Claude secundário também falhou (iteration 0), fallback OpenAI ${FALLBACK_MODEL}: ${secondaryErrMsg}`,
        );
        try {
          const r = await runWithOpenAI({ ...input, model: FALLBACK_MODEL });
          return { ...r, primary_error: primaryErrMsg, secondary_error: secondaryErrMsg };
        } catch (err3) {
          const tertiaryErrMsg = err3 instanceof Error ? err3.message : String(err3);
          console.error(`[LLM] OpenAI fallback também falhou: ${tertiaryErrMsg}`);
          return { ...llmFailureStub(model), primary_error: primaryErrMsg, secondary_error: secondaryErrMsg };
        }
      }
    }
  }

  // Já é OpenAI — sem fallback.
  try {
    return await runWithOpenAI({ ...input, model });
  } catch (err) {
    console.error(
      `[LLM] OpenAI (${model}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return llmFailureStub(model);
  }
}

function llmFailureStub(model: string): RunWithToolsOutput {
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
    let response;
    try {
      response = await client.messages.create({
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
    } catch (err) {
      // Fix CRITICAL stress test 2026-05-03: se já executamos tools nessa
      // chamada, NÃO permitir fallback pra outro provider (re-execução).
      // Throw error especial que runWithTools catch sem fallback.
      if (tool_calls.length > 0) {
        throw new LLMFailureMidLoop(
          i,
          {
            tool_calls,
            model_used: input.model,
            prompt_tokens: totalPromptTokens,
            completion_tokens: totalCompletionTokens,
            cached_tokens: totalCachedTokens,
            iterations: i,
            stopped_reason: "error" as const,
          },
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      throw err;  // iteration 0, fallback OK
    }

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
          content: truncateToolResult(JSON.stringify(result)),
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
          content: truncateToolResult(JSON.stringify({ status: "error", message: errorMsg })),
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

// =====================================================
// OpenAI fallback (tool use API com mesmo loop multi-turn)
// =====================================================

async function runWithOpenAI(input: RunWithToolsInput & { model: string }): Promise<RunWithToolsOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY não configurada (fallback indisponível).");
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, timeout: 45000, maxRetries: 1 });

  // Converte messages do formato genérico pra OpenAI ChatCompletion
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: "system", content: input.systemPrompt }];
  for (const m of input.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
    } else {
      // Multimodal: converte image blocks pro formato OpenAI
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];
      for (const block of m.content) {
        if (block.type === "text" && block.text) {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image" && block.source) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
      }
      messages.push({ role: m.role, content: parts });
    }
  }

  const tools = input.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const tool_calls: RunWithToolsOutput["tool_calls"] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const completion = await client.chat.completions.create({
      model: input.model,
      messages,
      tools,
      temperature: 0.3,
      max_tokens: 2500,
      store: true, // ativa OpenAI prompt caching automático
    });

    const usage = completion.usage;
    totalPromptTokens += usage?.prompt_tokens || 0;
    totalCompletionTokens += usage?.completion_tokens || 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    totalCachedTokens += (usage as any)?.prompt_tokens_details?.cached_tokens || 0;

    const msg = completion.choices[0]?.message;
    if (!msg) {
      return {
        text: "(sem resposta)", tool_calls, model_used: input.model,
        prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens,
        cached_tokens: totalCachedTokens, iterations: i + 1, stopped_reason: "error",
      };
    }

    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Sem tool calls — fim do turno
      return {
        text: msg.content || "(sem resposta)",
        tool_calls,
        model_used: input.model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        cached_tokens: totalCachedTokens,
        iterations: i + 1,
        stopped_reason: "end_turn",
      };
    }

    // Executa tool calls
    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      const args: Record<string, unknown> = (() => {
        try { return JSON.parse(tc.function.arguments); } catch { return {}; }
      })();
      try {
        const result = await input.executor(tc.function.name, args);
        tool_calls.push({ name: tc.function.name, input: args, result });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: truncateToolResult(JSON.stringify(result)),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "tool execution failed";
        tool_calls.push({
          name: tc.function.name,
          input: args,
          result: { status: "error", message: errorMsg },
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: truncateToolResult(JSON.stringify({ status: "error", message: errorMsg })),
        });
      }
    }
  }

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
