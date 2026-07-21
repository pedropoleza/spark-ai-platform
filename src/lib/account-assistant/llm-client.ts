/**
 * LLM client com tool-calling. Claude Sonnet 4.6 como default (melhor em
 * tool use complexo), fallback automático pra GPT-4.1 se Claude falhar.
 *
 * Implementa loop multi-turn: se o modelo chama tool, executamos, retornamos
 * o resultado e rodamos de novo até o modelo parar de chamar tools ou
 * atingir maxIterations.
 */

import type { ToolDefinition } from "@/types/account-assistant";
import { withDeadline, DeadlineExceededError } from "@/lib/utils/deadline";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const FALLBACK_MODEL = "gpt-4.1";
// H30.3 (Pedro 2026-05-15): bumped 6→10 pra suportar multi-action chaining
// (rep manda 1 msg com N ações, bot executa em chain no mesmo turn).
const MAX_ITERATIONS = 10;

// Anti-timeout silencioso (incidente Manuela 2026-06-22): o endpoint tem
// maxDuration=60s. Um turno com MUITAS tool calls lentas (ex: criar 14
// appointments com validação de slot no GHL) estoura os 60s DENTRO de uma
// iteração → a Vercel mata a lambda → NENHUM catch roda → rep fica no silêncio
// total (sem resposta, sem signal). Orçamento de wall-clock: ao se aproximar do
// limite, PARAMOS e devolvemos um fallback gracioso (stopped_reason time_budget)
// — deixando ~15s de folga pro coherence/billing/envio depois do loop.
//
// Ultra-review 2026-07-17 (casos Luciano 10 msgs mudas/6d + Fabiana): o budget
// era checado só ENTRE passos — os 2 buracos que matavam a lambda muda eram:
//  (A) a chamada LLM tinha timeout próprio de 60s (client) + retries, maior
//      que o tempo RESTANTE do turno → agora cada create() recebe timeout =
//      restante do budget (+ margem) e só re-tenta se sobra tempo;
//  (B) UMA tool lenta (ex: preview de bulk paginando o CRM) estourava o budget
//      POR DENTRO → agora cada tool corre contra o tempo restante via
//      withDeadline; estourou → resultado sintético honesto + fallback AGORA.
const TURN_BUDGET_MS = 45_000;
// Teto por tool: nenhuma tool pode consumir mais que isto (mesmo com budget
// sobrando) — uma tool nesse patamar é bug dela, não razão pra matar o turno.
const TOOL_DEADLINE_CAP_MS = 30_000;
// Mensagem sintética quando a tool estoura o deadline. JS não cancela a
// promise: a ação PODE concluir depois do corte — por isso manda CONFERIR.
const TOOL_TIMEOUT_RESULT = {
  status: "error",
  message:
    "tempo esgotado dentro da tool — a ação PODE ter rodado parcialmente (ou até concluído). " +
    "CONFIRA o estado real antes de repetir; NÃO repita às cegas.",
} as const;

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
// Fix Track 12 C3 (review 2026-05-05): antes era const lido em module-load.
// Lambdas warm não captavam mudanças de env sem cold-start (~15min de drift).
// Agora função chamada por request — flip do env propaga em <30s.
function isStrictClaudeOnly(): boolean {
  return process.env.STRICT_CLAUDE_ONLY === "1";
}

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
 * A2 (estudo de custo 2026-07-20): decisão PURA (testável) de encerrar o loop numa
 * tool terminal. Regras: (1) a resposta do modelo teve EXATAMENTE um tool_use;
 * (2) ele é uma tool terminal registrada; (3) a execução não devolveu status:"error";
 * (4) o validate (se houver) aprova o input — validate que LANÇA conta como reprovado.
 * Qualquer "não" → o loop segue normal (o LLM vê o resultado e escreve o texto).
 */
export function shouldEndOnTerminalTool(params: {
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  terminalTools?: Array<{ name: string; validate?: (input: Record<string, unknown>) => boolean }>;
  /** A última tool_call registrada nesta iteração ({name, result}). */
  lastCall?: { name: string; result: unknown } | null;
}): boolean {
  const { toolUses, terminalTools, lastCall } = params;
  if (toolUses.length !== 1 || !terminalTools?.length) return false;
  const tu = toolUses[0];
  const t = terminalTools.find((x) => x.name === tu.name);
  if (!t) return false;
  const execOk =
    !!lastCall && lastCall.name === tu.name &&
    (lastCall.result as { status?: string } | null | undefined)?.status !== "error";
  if (!execOk) return false;
  if (t.validate) {
    try {
      return t.validate(tu.input);
    } catch {
      return false;
    }
  }
  return true;
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
  /**
   * Deadline ABSOLUTO do turno (epoch ms) — H52 review adversarial 2026-07-17.
   * Setado UMA vez no runWithTools e herdado por TODA a cadeia de fallback
   * (primário → Haiku → OpenAI). Antes, cada provider re-ancorava o próprio
   * budgetStart: um turno que caía pro secundário podia somar 45s+45s > o
   * hard-limit de 60s da lambda e morrer mudo do mesmo jeito.
   */
  deadlineAt?: number;
  /**
   * Modelo secundário pra fallback se o primário falhar (rate-limit, 5xx
   * sem tool calls). Default Claude Haiku 4.5 (mesmo provider, capacity
   * pool diferente). Configurável via agent_configs.fallback_model.
   * Se não-Claude, ainda tenta. Se vazio/null, mantém Haiku 4.5.
   */
  fallbackModel?: string | null;
  /**
   * F4 (cost-reduction 2026-06) — ⚠️ REVERTIDO em A1 (estudo de custo 2026-07-20):
   * o TTL 1h foi medido NET-NEGATIVO (18% dos gaps >1h = frios de qualquer jeito,
   * vs só 10% na janela 5-60min que ele salvava) E sub-cobrado (Anthropic fatura
   * write 1h a 2x = $6/M no sonnet; pricing.ts cobrava 1.25x = ~$56-63/mês
   * invisíveis ao cost_usd). O SPARKBOT não passa mais "1h" por aqui. ⚠️ O
   * LEAD-FACING (queue-processor.ts → openai-client.ts, plumbing PRÓPRIO de
   * cacheTtl) AINDA passa "1h" — lá o 1h é net-POSITIVO (hit ~70%) mas o
   * billing segue cobrando write a 1,25x = furo ~$15-19/mês ABERTO (review
   * Onda A 2026-07-21). Fix pendente: ler usage.cache_creation.
   * ephemeral_{5m,1h}_input_tokens do SDK e cobrar o bucket 1h a 2x no
   * pricing.ts — vale pros DOIS caminhos se o 1h voltar aqui.
   */
  cacheTtl?: "5m" | "1h";
  /**
   * A4 (estudo de custo 2026-07-20): desliga TODO cache_control da chamada
   * (prefixo E histórico). Pra disparos agendados 1x/dia (Resumo matinal etc):
   * a cadência (24h) é maior que o TTL máximo do cache (1h), então o write
   * premium de 1.25x era pago todo dia e NUNCA lido (medido: cache_read=0 em
   * 126/126 runs do Resumo matinal).
   */
  disableCache?: boolean;
  /**
   * A2 (estudo de custo 2026-07-20): tools TERMINAIS. Quando a resposta do
   * modelo contém EXATAMENTE um tool_use desta lista, com `validate(input)` ok
   * e execução sem erro, o loop retorna SEM a chamada LLM seguinte — o caller
   * gera o texto final deterministicamente e DESCARTAVA o texto dessa chamada
   * (caso present_options: ~76K tok de prefixo relido pra um texto jogado fora,
   * 683x/mês). Payload inválido ou erro na tool → loop segue normal (o LLM vê
   * o resultado e reage). Implementado no caminho Claude; o fallback OpenAI
   * (raro) mantém o comportamento antigo (paga a chamada extra, sem quebrar).
   */
  terminalTools?: Array<{
    name: string;
    validate?: (input: Record<string, unknown>) => boolean;
  }>;
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
  /**
   * Tokens GRAVADOS no cache (Anthropic cache_creation_input_tokens). Subconjunto
   * de prompt_tokens, cobrado a 125% (cacheWriteInput). Opcional: só o caminho
   * Claude popula; OpenAI/erro deixam undefined → call site usa `?? 0`. Sem isso,
   * o billing cobrava esses tokens ao fresh rate (subcobrança ~25%) — C3-3.
   */
  cache_creation_tokens?: number;
  iterations: number;
  /** "terminal_tool" (A2): encerrado numa tool terminal — text vem VAZIO de
   *  propósito; o caller gera o texto final (ex: interactiveFallbackText). */
  stopped_reason: "end_turn" | "max_iterations" | "error" | "time_budget" | "terminal_tool";
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
  // H52: um ÚNICO relógio pro turno inteiro, fallbacks inclusos.
  input = { ...input, deadlineAt: input.deadlineAt ?? Date.now() + TURN_BUDGET_MS };
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
      // H1: tenta secundário antes de cair pra OpenAI. Configurável via
      // input.fallbackModel (admin pode escolher Haiku, GPT-4.1 etc).
      // Default Haiku 4.5 (mesmo provider Anthropic, capacity pool diferente).
      // Detecta provider pelo prefixo do nome do modelo.
      const secondary = input.fallbackModel?.trim() || SECONDARY_CLAUDE_MODEL;
      const secondaryIsClaude = secondary.startsWith("claude-");
      console.error(
        `[LLM] Claude primário (${model}) falhou (iteration 0, sem tools), tentando ${secondary}: ${primaryErrMsg}`,
      );
      try {
        const r = secondaryIsClaude
          ? await runWithClaude({ ...input, model: secondary })
          : await runWithOpenAI({ ...input, model: secondary });
        // H52 R2: com maxRetries=0 (anti-timeout), um blip 429/5xx no primário
        // cai DIRETO aqui — o downgrade pro secundário era invisível (só a
        // falha dupla sinalizava). Signal medium dedupado torna o volume de
        // degradação observável sem depender de reclamação de rep.
        try {
          const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
          recordSignalAsync({
            type: "failure",
            title: "SparkBot: tier primário degradado (turno completou no fallback)",
            description:
              `Primário ${model} falhou na iteração 0 e o turno completou no ${secondary}. ` +
              `Com maxRetries=0 (anti-timeout H52) blips transitórios caem direto no fallback — ` +
              `se o occurrence subir rápido, é rate-limit/outage do primário. Erro: ${primaryErrMsg.slice(0, 200)}`,
            severity: "medium",
            source: "bot_auto",
            metadata: { primary: model, secondary, error_snippet: primaryErrMsg.slice(0, 200) },
          });
        } catch { /* signal não-crítico */ }
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
        if (isStrictClaudeOnly()) {
          console.error(
            `[LLM] STRICT_CLAUDE_ONLY=1 — não cai pra OpenAI. Erro Claude secundário: ${secondaryErrMsg}`,
          );
          return { ...llmFailureStub(model), primary_error: primaryErrMsg, secondary_error: secondaryErrMsg };
        }
        console.error(
          `[LLM] Claude secundário também falhou (iteration 0), fallback OpenAI ${FALLBACK_MODEL}: ${secondaryErrMsg}`,
        );

        // Fix Pedro 2026-05-06: auto-signal admin quando AMBOS Claude
        // primary E secondary falham. Indica Anthropic API DOWN ou
        // CRÉDITO INSUFICIENTE — bot tá em fallback OpenAI degradado
        // (compliance ~85% pior). Pedro vê em /admin/signals.
        // Padrão "credit balance" / "rate_limit" / "401" detectados
        // separadamente pra severity adequada.
        try {
          const combined = `${primaryErrMsg}\n${secondaryErrMsg}`;
          let title = "🚨 Claude API DOWN — bot rodando em fallback OpenAI";
          let severity: "high" | "medium" = "high";
          if (/credit balance|insufficient.*credit|payment/i.test(combined)) {
            title = "💳 Anthropic SEM CRÉDITO — recarregar urgente";
          } else if (/rate.?limit|429/i.test(combined)) {
            title = "⏱️ Claude rate limit — fallback temporário OpenAI";
            severity = "medium";
          } else if (/401|unauthor|invalid.*key/i.test(combined)) {
            title = "🔑 Anthropic API key inválida ou revogada";
          }
          const { recordSignalAsync } = await import(
            "@/lib/admin-signals/recorder"
          );
          recordSignalAsync({
            type: "failure",
            title,
            description:
              `Primary (${DEFAULT_MODEL}) e Secondary (${SECONDARY_CLAUDE_MODEL}) falharam. ` +
              `Bot caiu em fallback ${FALLBACK_MODEL} (OpenAI), que tem compliance ~85% pior em prompt-following. ` +
              `Esperar problemas em confirmation gate, identity, ID corruption.\n\n` +
              `Primary err: ${primaryErrMsg.slice(0, 300)}\n` +
              `Secondary err: ${secondaryErrMsg.slice(0, 300)}`,
            severity,
            source: "bot_auto",
            metadata: {
              primary_model: DEFAULT_MODEL,
              secondary_model: SECONDARY_CLAUDE_MODEL,
              fallback_model: FALLBACK_MODEL,
              primary_error_snippet: primaryErrMsg.slice(0, 200),
              secondary_error_snippet: secondaryErrMsg.slice(0, 200),
            },
          });
        } catch {
          /* signal não crítico */
        }

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

  // F3 (cost-reduction 2026-06): 3º cache breakpoint no FIM do histórico estável.
  // Marca o ÚLTIMO bloco do PENÚLTIMO message (a última msg estável do histórico; o último
  // message é a user message volátil do turno atual). Sem isto o histórico vinha DEPOIS dos 2
  // markers (tools+system) e não cacheava. Ganho REAL = o PREFIXO-COMUM do histórico entre
  // turnos consecutivos (o histórico cresce/desloca, então casa só até onde os bytes batem —
  // NÃO o histórico inteiro). Oportunístico, mas de graça (sobrava breakpoint).
  // Aplicado UMA VEZ aqui, ANTES do loop — NUNCA dentro: senão, após os push de tool_use/
  // tool_result, o marker pularia de posição e o prefixo cacheado mudaria a cada iteração.
  // TTL default (5min): o histórico cresce todo turno, não compensa o write 2x do 1h aqui.
  // Breakpoints ativos: tools[último] + system + este penúltimo-message = 3 de 4 (sobra 1).
  if (!input.disableCache && messages.length >= 2) {
    const penIdx = messages.length - 2;
    const pen = messages[penIdx];
    const blocks: AnthropicBlock[] =
      typeof pen.content === "string"
        ? [{ type: "text", text: pen.content }]
        : [...pen.content];
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } } as any;
      messages[penIdx] = { ...pen, content: blocks };
    }
  }

  // F4 (cost-reduction 2026-06) — REVERTIDO em A1 (2026-07-20): nenhum caller passa mais
  // "1h" (net-negativo + sub-cobrado; ver doc do campo cacheTtl). O mecanismo fica pra
  // eventual reativação COM billing por bucket. O breakpoint do histórico (F3) é SEMPRE 5m.
  const stablePrefixCache =
    input.cacheTtl === "1h"
      ? ({ type: "ephemeral", ttl: "1h" } as const)
      : ({ type: "ephemeral" } as const);

  const tools = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const tool_calls: RunWithToolsOutput["tool_calls"] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;
  let totalCacheCreationTokens = 0;

  // Orçamento de tempo (anti-timeout silencioso) — ver TURN_BUDGET_MS.
  // H52 (review adversarial 2026-07-17): o relógio é ABSOLUTO e herdado do
  // runWithTools (input.deadlineAt) — o MESMO deadline atravessa a cadeia de
  // fallback; cada provider NÃO re-ancora o orçamento.
  const deadlineAt = input.deadlineAt ?? Date.now() + TURN_BUDGET_MS;
  const remainingMs = () => deadlineAt - Date.now();
  const budgetReturn = (iters: number, timedOutMidTool = false): RunWithToolsOutput => ({
    // H52: quando UMA tool estourou o deadline no meio, o texto precisa avisar
    // que a ação PODE ter concluído (JS não cancela a promise) — o texto
    // genérico ("me confirma o que falta") convidava o rep a REPETIR uma ação
    // possivelmente executada (ex: disparo em dobro).
    text: timedOutMidTool
      ? "Uma das ações demorou demais e precisei parar no meio dela. ⚠️ Ela PODE ter sido concluída mesmo assim — me pede pra conferir o que entrou antes de repetir, beleza?"
      : "Tô levando tempo demais pra fazer tudo isso de uma vez e precisei parar pra não travar. Me confirma o que ainda falta que eu sigo daí 👍",
    tool_calls,
    model_used: input.model,
    prompt_tokens: totalPromptTokens,
    completion_tokens: totalCompletionTokens,
    cached_tokens: totalCachedTokens,
    cache_creation_tokens: totalCacheCreationTokens,
    iterations: iters,
    stopped_reason: "time_budget",
  });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (remainingMs() <= 0) return budgetReturn(i);
    let response;
    try {
      // Fix Track 12 M1 (review 2026-05-05): aplica cache_control no ÚLTIMO
      // tool além do system prompt. Tools array (~30 defs JSON pesado) é
      // estável entre turns — ~30% economia de input tokens em cache hit.
      // Anthropic cacheia tudo até o último marker ephemeral inclusivo.
      // A4: disableCache → nenhum marker (disparo 1x/dia nunca relê o cache;
      // o write premium era custo puro).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolsWithCache: any = !input.disableCache && Array.isArray(tools) && tools.length > 0
        ? tools.map((t, idx) =>
            idx === tools.length - 1
              ? { ...t, cache_control: stablePrefixCache }
              : t,
          )
        : tools;
      // Anti-timeout (H52, buraco A / caso Luciano): a chamada LLM não pode
      // levar o turno além do orçamento. ⚠️ O timeout do SDK é POR TENTATIVA e
      // o SDK re-tenta timeout por default — timeout 50s × retries estourava o
      // hard-limit 60s do mesmo jeito (achado do review adversarial). Por isso:
      // maxRetries: 0 SEMPRE (falha rápida cai na NOSSA cadeia de fallback
      // Haiku/OpenAI, que herda ESTE MESMO deadline) e teto de 35s por chamada,
      // nunca além do que resta do turno (-5s de folga pro pós-call).
      response = await client.messages.create(
        {
          model: input.model,
          max_tokens: 2500,
          system: [
            input.disableCache
              ? { type: "text" as const, text: input.systemPrompt }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              : ({ type: "text", text: input.systemPrompt, cache_control: stablePrefixCache } as any),
          ],
          tools: toolsWithCache,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: messages as any,
          temperature: 0.3, // mais determinístico pra tool use
        },
        {
          timeout: Math.min(35_000, Math.max(2_000, remainingMs() - 5_000)),
          maxRetries: 0,
        },
      );
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
    // Fix bug observado em prod 2026-05-03: cache_creation_input_tokens
    // (tokens sendo ESCRITOS ao cache no primeiro turn de uma sessão) não
    // estavam sendo somados, subfaturando ~40K tokens por nova sessão.
    // Anthropic devolve 3 buckets: input (fresh, fora do cache), cache_read
    // (lido do cache), cache_creation (escrito agora ao cache pra próximo
    // turn). Pra prompt_tokens total — análogo ao formato OpenAI — soma os 3.
    const cacheCreation = usage?.cache_creation_input_tokens || 0;
    // Normalizar: prompt_tokens = total de input (fresh + cached + creation),
    // igual o formato da OpenAI. Evita cache % > 100% quando UI divide
    // cached/prompt e evita underbilling no primeiro turn.
    totalPromptTokens += freshInput + cachedInput + cacheCreation;
    totalCompletionTokens += response.usage?.output_tokens || 0;
    totalCachedTokens += cachedInput;
    totalCacheCreationTokens += cacheCreation;

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
        cache_creation_tokens: totalCacheCreationTokens,
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
        cache_creation_tokens: totalCacheCreationTokens,
        iterations: i + 1,
        stopped_reason: "end_turn",
      };
    }

    const toolResults: AnthropicToolResultBlock[] = [];
    for (const tu of toolUses) {
      // Anti-timeout: se o lote de tools (ex: 14 appointments) já estourou o
      // orçamento, para AQUI com fallback gracioso em vez de a lambda morrer.
      // Buraco B (H52, casos Luciano/Fabiana): UMA tool lenta (ex: preview de
      // bulk paginando o CRM) estourava o orçamento POR DENTRO e a lambda
      // morria muda. A tool corre contra o tempo restante do turno; estourou →
      // resultado sintético honesto + fallback gracioso AGORA.
      const remainingForTool = remainingMs();
      if (remainingForTool < 3_000) return budgetReturn(i);
      try {
        const result = await withDeadline(
          input.executor(tu.name, tu.input),
          Math.min(Math.max(remainingForTool - 1_000, 2_000), TOOL_DEADLINE_CAP_MS),
          tu.name,
        );
        tool_calls.push({ name: tu.name, input: tu.input, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: truncateToolResult(JSON.stringify(result)),
        });
      } catch (err) {
        if (err instanceof DeadlineExceededError) {
          tool_calls.push({ name: tu.name, input: tu.input, result: TOOL_TIMEOUT_RESULT });
          return budgetReturn(i, true);
        }
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

    // A2 (estudo de custo 2026-07-20): tool TERMINAL — se a resposta teve SÓ ela,
    // payload válido e execução ok, encerra AQUI. A chamada LLM seguinte era paga
    // (~76K tok de prefixo relido) e o texto dela DESCARTADO pelo caller, que gera
    // o texto final deterministicamente (present_options → interactiveFallbackText).
    // Erro na tool ou payload inválido → loop segue normal (o LLM reage/reescreve).
    if (
      shouldEndOnTerminalTool({
        toolUses,
        terminalTools: input.terminalTools,
        lastCall: tool_calls[tool_calls.length - 1] ?? null,
      })
    ) {
      return {
        text: "",
        tool_calls,
        model_used: input.model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        cached_tokens: totalCachedTokens,
        cache_creation_tokens: totalCacheCreationTokens,
        iterations: i + 1,
        stopped_reason: "terminal_tool",
      };
    }
  }

  // Loop excedeu maxIterations
  return {
    text: "Executei várias ações mas preciso parar aqui. Me pede de novo se faltou algo.",
    tool_calls,
    model_used: input.model,
    prompt_tokens: totalPromptTokens,
    completion_tokens: totalCompletionTokens,
    cached_tokens: totalCachedTokens,
    cache_creation_tokens: totalCacheCreationTokens,
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

  // Orçamento de tempo (anti-timeout silencioso) — ver TURN_BUDGET_MS.
  // H52: relógio ABSOLUTO herdado da cadeia (ver runWithClaude — mesma lógica).
  const deadlineAt = input.deadlineAt ?? Date.now() + TURN_BUDGET_MS;
  const remainingMs = () => deadlineAt - Date.now();
  const budgetReturn = (iters: number, timedOutMidTool = false): RunWithToolsOutput => ({
    text: timedOutMidTool
      ? "Uma das ações demorou demais e precisei parar no meio dela. ⚠️ Ela PODE ter sido concluída mesmo assim — me pede pra conferir o que entrou antes de repetir, beleza?"
      : "Tô levando tempo demais pra fazer tudo isso de uma vez e precisei parar pra não travar. Me confirma o que ainda falta que eu sigo daí 👍",
    tool_calls,
    model_used: input.model,
    prompt_tokens: totalPromptTokens,
    completion_tokens: totalCompletionTokens,
    cached_tokens: totalCachedTokens,
    iterations: iters,
    stopped_reason: "time_budget",
  });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (remainingMs() <= 0) return budgetReturn(i);
    // Anti-timeout (H52): mesmo tratamento do caminho Claude — timeout POR
    // TENTATIVA ≤ restante do turno e maxRetries 0 (o SDK re-tenta timeout
    // com o mesmo teto; 2 tentativas de 45s estourariam o hard-limit).
    const completion = await client.chat.completions.create(
      {
        model: input.model,
        messages,
        tools,
        temperature: 0.3,
        max_tokens: 2500,
        store: true, // ativa OpenAI prompt caching automático
      },
      {
        timeout: Math.min(35_000, Math.max(2_000, remainingMs() - 5_000)),
        maxRetries: 0,
      },
    );

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
      // Buraco B (H52): deadline por tool — paridade com o caminho Claude;
      // tool lenta não pode matar a lambda muda.
      const remainingForTool = remainingMs();
      if (remainingForTool < 3_000) return budgetReturn(i);
      const args: Record<string, unknown> = (() => {
        try { return JSON.parse(tc.function.arguments); } catch { return {}; }
      })();
      try {
        const result = await withDeadline(
          input.executor(tc.function.name, args),
          Math.min(Math.max(remainingForTool - 1_000, 2_000), TOOL_DEADLINE_CAP_MS),
          tc.function.name,
        );
        tool_calls.push({ name: tc.function.name, input: args, result });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: truncateToolResult(JSON.stringify(result)),
        });
      } catch (err) {
        if (err instanceof DeadlineExceededError) {
          tool_calls.push({ name: tc.function.name, input: args, result: TOOL_TIMEOUT_RESULT });
          return budgetReturn(i, true);
        }
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
