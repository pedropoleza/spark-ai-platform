import OpenAI from "openai";
import type { AIResponse, AIProcessingResult } from "@/types/ai";
import { sanitizeAgentMessage } from "@/lib/ai/response-sanitizer";
import { reportError } from "@/lib/admin-signals/report-error";

const OPENAI_VISION_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"];
// Fix MED-7 (deep review 2026-05-05): detectar Claude por prefix em vez de
// hardcoded version list. Antes, claude-sonnet-4-7-* (versão futura) caía em
// OpenAI client → erro modelo desconhecido. Agora qualquer "claude-*" funciona.

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
  return model.startsWith("claude-");
}

function supportsVision(model: string): boolean {
  if (isClaude(model)) return true;
  return OPENAI_VISION_MODELS.some((m) => model.startsWith(m));
}

function supportsStructuredOutputs(model: string): boolean {
  return model.startsWith("gpt-4o") || model.startsWith("gpt-4.1") || model.startsWith("gpt-5");
}

/**
 * Schema da TOOL pro structured output do Claude (Fix definitivo do parse-fail
 * 2026-06-22). Clona o schema de resposta e RELAXA só o `message` pra aceitar
 * string OU array de bolhas — o Claude manda multi-bubble e a gente preserva
 * isso (o schema base tem message:string, certo pro OpenAI; aqui não). O resto do
 * schema (anyOf das actions, union type:[string,null] do collected_data,
 * additionalProperties:false) é JSON Schema padrão e o tool-use do Claude aceita.
 * Não muta o original (clona via JSON).
 *
 * ⚠️ NÃO setar `strict:true` nesta tool. A chamada passa SÓ `responseSchema.schema`
 * (o `strict:true` de buildResponseJsonSchema fica de fora de propósito), então a
 * tool roda NON-STRICT = o input_schema é GUIA best-effort, não grammar rígido. É
 * justamente isso que faz o `anyOf` das actions + `type:["string","null"]` do
 * collected_data serem aceitos sem 400. Se alguém mover `strict:true` pra dentro,
 * o grammar-constrained sampling recusa `anyOf` em array items → 400 → o fail-open
 * salva (cai no texto+repair), mas o tier estruturado degrada em SILÊNCIO pra
 * sempre. O sinal de reportError no fallback (processWithClaude) pega esse regime.
 */
function buildClaudeToolSchema(schema: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const props = clone.properties as Record<string, { description?: string }> | undefined;
  if (props && props.message) {
    props.message = {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
      description: props.message.description || "Resposta ao lead (1 ou mais bolhas). Nunca vazio.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
  return clone;
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

/**
 * Cadeia de fallback cross-provider (Fix bug observado em prod 2026-06-16: o
 * apagão de crédito da Anthropic deu 400 e o caminho lead-facing NÃO tinha
 * fallback — dropou leads a seco dentro da janela, enquanto o SparkBot caía pro
 * OpenAI). A cadeia tenta: o modelo pedido → um Claude barato (erro transitório
 * do Claude) → OUTRO provider (salva apagão de conta/crédito do provider
 * primário). `STRICT_CLAUDE_ONLY=1` desliga o tier OpenAI (~85% pior compliance
 * no stress test do SparkBot — mas ainda melhor que lead mudo). O fallback só
 * dispara em FALHA, então o caminho feliz e o custo normal ficam idênticos.
 */
function buildModelChain(primary: string): string[] {
  // `=== "1"` igual ao SparkBot (llm-client.ts) — fonte única, sem divergência
  // (um STRICT_CLAUDE_ONLY="true" não pode desligar OpenAI aqui e não lá).
  const strictClaude = process.env.STRICT_CLAUDE_ONLY === "1";
  const chain: string[] = [primary];
  if (isClaude(primary)) {
    if (!primary.startsWith("claude-haiku")) chain.push("claude-haiku-4-5-20251001");
    if (!strictClaude) chain.push("gpt-4.1-mini");
  } else {
    // Primary OpenAI → fallback pro Claude (cobre apagão de conta OpenAI).
    if (!strictClaude) chain.push("claude-haiku-4-5-20251001");
  }
  return chain.filter((m, i) => chain.indexOf(m) === i);
}

export async function processWithAI(input: ProcessMessageInput): Promise<AIProcessingResult> {
  const startTime = Date.now();
  const chain = buildModelChain(input.model);
  const errors: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const result = await runOneModel({ ...input, model }, startTime);
      if (result.success) {
        if (i > 0) {
          // Caiu pro fallback — loga qual tier salvou e por quê (telemetria de
          // degradação; o erro do tier primário não pode sumir).
          console.warn(
            `[AI] fallback OK no tier ${i} (model=${model}) após falha de [${chain.slice(0, i).join(", ")}]: ${errors.join(" | ")}`,
          );
          // Sinal de DEGRADAÇÃO não-terminal: o fallback respondeu, mas o tier
          // primário está falhando. Sem isso, um apagão MASCARADO pelo fallback
          // (ex: crédito Anthropic — cenário 2026-06-16) ficaria invisível até
          // virar outage total. Title estável dedupa; severity medium só empurra
          // push quando occ≥20 (apagão sustentado) — blips ficam quietos.
          reportError({
            title: "LLM lead-facing: tier primário degradado (fallback ativo)",
            feature: "openai-client",
            severity: "medium",
            error: new Error(errors.join(" | ")),
            metadata: { primary: input.model, savedByTier: i, model },
          });
        }
        return result;
      }
      errors.push(`${model}: ${result.error || "falha (success=false)"}`);
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : "erro desconhecido"}`);
    }
  }

  // TODOS os tiers falharam — NUNCA silencioso. Vira admin_signal (high) +
  // Sentry; com o canal de push setado (observability-alerts), pinga na hora.
  const aggErr = errors.join(" | ");
  reportError({
    title: "LLM lead-facing: todos os providers/tiers falharam",
    feature: "openai-client",
    severity: "high",
    error: new Error(aggErr),
    metadata: { primary: input.model, chain },
  });
  return {
    success: false,
    response: null,
    error: `Todos os modelos falharam: ${aggErr}`,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Executa UMA tentativa com um modelo específico (sem fallback). Faz o budget/
 * trim e despacha pro provider certo. Throw OU `success:false` sobem pro
 * processWithAI, que decide o próximo tier da cadeia.
 */
async function runOneModel(input: ProcessMessageInput, startTime: number): Promise<AIProcessingResult> {
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
    // Fix CRIT-3 (deep review 2026-05-05): filter content vazio.
    // Claude rejeita user msg com content="" → 400 invalid_request. OpenAI
    // tolera mas comportamento bizarro. Substituir por placeholder pra
    // preservar turn boundary.
    for (const turn of conversationMessages!) {
      const safe = turn.content && turn.content.trim()
        ? turn.content
        : "[mensagem vazia]";
      messages.push({ role: turn.role, content: safe });
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
    0, // OpenAI não tem cache-write premium (cacheWriteInput == input)
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
    // Fix CRIT-3 (deep review 2026-05-05): filter content vazio (mesma
    // lógica do path OpenAI acima).
    for (const turn of conversationMessages!) {
      const safe = turn.content && turn.content.trim()
        ? turn.content
        : "[mensagem vazia]";
      messages.push({ role: turn.role, content: safe });
    }
  }
  messages.push({ role: "user", content: currentContent });
  // NB (review 2026-06-17): NADA de prefill de assistant aqui — a família Claude
  // 4.6+ (Sonnet 4.6, o default lead-facing) retorna 400 em prefill de último
  // turno assistant (foi removido; confirmado na ref oficial da Claude API). Pra
  // forçar JSON, a rede é o REPAIR em parseAIResponse (escapeControlCharsInStrings)
  // + futuro structured outputs (output_config.format, GA no Sonnet 4.6) — este
  // último precisa validar a compat do schema (union type:["string","null"]).

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const systemBlocks: any[] = [
    { type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  // === STRUCTURED OUTPUT VIA TOOL-USE (Fix definitivo do parse-fail 2026-06-22) ===
  // Força o Claude a devolver o JSON como INPUT de uma tool → o SDK entrega já
  // PARSEADO (zero parse de texto = zero "Desculpa, tive um problema técnico").
  // Vale pra TODOS os agentes lead-facing no Claude (Marina/Bianca/Jussara/etc).
  // FAIL-OPEN TOTAL: se a tool for rejeitada (400/schema) ou não vier o bloco
  // tool_use, cai no path de texto + repair (o comportamento de hoje) — nunca
  // fica pior que antes. Flag CLAUDE_STRUCTURED_OUTPUT=0 desliga sem deploy.
  const useClaudeTool = process.env.CLAUDE_STRUCTURED_OUTPUT !== "0" && !!input.responseSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let response: any = null;
  let toolJson: string | null = null;
  if (useClaudeTool) {
    try {
      const r = await client.messages.create({
        model: input.model,
        max_tokens: 2500,
        system: systemBlocks,
        messages,
        temperature: 0.8,
        tools: [
          {
            name: "agent_response",
            description: "Devolve a SUA resposta estruturada ao lead neste turno.",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            input_schema: buildClaudeToolSchema(input.responseSchema!.schema) as any,
          },
        ],
        tool_choice: { type: "tool", name: "agent_response" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tu = r.content.find((b: any) => b.type === "tool_use");
      if (tu && "input" in tu) {
        toolJson = JSON.stringify(tu.input); // já é objeto válido → stringify nunca falha
        response = r;
      } else {
        response = null; // sem tool_use (inesperado com forced) → fallback texto
      }
    } catch (e) {
      console.warn(
        `[Claude structured] tool-use falhou (${input.model}), fallback p/ texto+repair:`,
        e instanceof Error ? e.message : e,
      );
      response = null;
    }
  }

  // Path de texto (comportamento atual + repair em parseAIResponse) — fail-open.
  if (!response) {
    // Observabilidade (review adversarial 2026-06-22): se o tool-use foi FORÇADO
    // (useClaudeTool) mas caiu aqui, houve falha/ausência do tool_use. Pontual =
    // ok (fail-open absorve). SISTEMÁTICO (schema rejeitado por mudança de API/SDK
    // ou data_field com char proibido) = 2 chamadas Claude por tier = CUSTO
    // DOBRADO em silêncio. reportError dedupa por título → vira 1 sinal com
    // occurrence_count crescente; severity medium só empurra push em volume, e o
    // Pedro pode bater o kill-switch CLAUDE_STRUCTURED_OUTPUT=0 antes da fatura.
    if (useClaudeTool) {
      reportError({
        title: "Claude structured output: tool-use caindo no fallback de texto",
        feature: "openai-client",
        severity: "medium",
        metadata: { model: input.model },
      });
    }
    response = await client.messages.create({
      model: input.model,
      max_tokens: 2500,
      system: systemBlocks,
      messages,
      temperature: 0.8,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textBlock = response.content.find((b: any) => b.type === "text");
  // toolJson (já parseado) tem precedência; senão usa o texto cru (que vai pro repair).
  const responseText = toolJson ?? (textBlock && "text" in textBlock ? textBlock.text : "");
  if (!responseText) return { success: false, response: null, error: "Resposta vazia do Claude" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = response.usage as any;
  const cachedTokens = (usage?.cache_read_input_tokens ?? 0);
  const cacheCreationTokens = (usage?.cache_creation_input_tokens ?? 0);
  const freshInput = response.usage?.input_tokens ?? 0;
  // prompt_tokens = TOTAL de input (fresh + cache_read + cache_creation), igual
  // ao SparkBot llm-client e ao formato OpenAI — casa com a convenção do
  // calculateCost (fresh = prompt − cached − creation). Antes passava só
  // input_tokens (fresh), o que fazia o calculateCost descontar cached do fresh
  // de novo (subcobrança) e ignorava o cache-write 125% (C3-3).
  const totalPrompt = freshInput + cachedTokens + cacheCreationTokens;
  return buildResult(
    responseText,
    totalPrompt,
    response.usage?.output_tokens,
    cachedTokens,
    cacheCreationTokens,
    startTime,
    Boolean(toolJson), // structured via tool-use? (só pra log/telemetria)
    input.priorTurnCount,
  );
}

// ===== Parser compartilhado =====
function buildResult(
  responseText: string,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  cachedTokens: number,
  cacheCreationTokens: number,
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
    cache_creation_tokens: cacheCreationTokens,
    cache_hit_ratio: cacheHitRatio,
    duration_ms: duration,
    parse_failed: parseFailed,
  };
}

/**
 * Escapa caracteres de controle (quebra de linha, CR, tab) que aparecem CRUS
 * DENTRO de strings JSON — o Claude às vezes faz isso e quebra o JSON.parse.
 * Pequena máquina de estado: só mexe no que está entre aspas; a estrutura fora
 * de strings fica intacta. Usado como last-resort antes do fallback.
 */
function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') { inStr = true; }
      out += ch;
    }
  }
  return out;
}

/** Remove vírgula sobrando antes de } ou ] (erro comum de LLM). Só-tolerância. */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Fecha chaves/colchetes faltando quando o modelo TRUNCA o JSON (output cortado).
 * Conta { [ fora de string e apenda os fechamentos que faltam — só APENDA, nunca
 * remove, então não corrompe um JSON já balanceado.
 */
function balanceBraces(s: string): string {
  let curly = 0, square = 0, inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }
  let out = s;
  while (square-- > 0) out += "]";
  while (curly-- > 0) out += "}";
  return out;
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Repair em CASCATA (Fix parse-fail observado em prod 2026-06-22, caso
      // Jussara: o bot caía em "Desculpa, tive um problema técnico" ao coletar o
      // nome). O Claude (sem structured outputs) às vezes deixa control-char cru,
      // vírgula sobrando OU trunca o JSON. Tenta reparos progressivos — todos só
      // tornam o parse MAIS tolerante, nunca alteram um JSON já válido — antes de
      // cair no fallback genérico. (Fix anterior 2026-06-17 só cobria control-char.)
      const base = escapeControlCharsInStrings(cleaned);
      const attempts = [base, stripTrailingCommas(base), balanceBraces(stripTrailingCommas(base))];
      let repaired: unknown;
      for (const a of attempts) {
        try { repaired = JSON.parse(a); break; } catch { /* tenta o próximo reparo */ }
      }
      if (repaired === undefined) throw new Error("json unrepairable após cascata de repair");
      parsed = repaired;
    }

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
