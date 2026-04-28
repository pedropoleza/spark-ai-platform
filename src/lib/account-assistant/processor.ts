/**
 * Pipeline principal do Sparkbot. Dado um rep + input do rep, decide se:
 * - Precisa enviar termos de uso (primeira vez)
 * - Precisa perguntar qual location (multi-location sem active setada)
 * - Chama LLM com tools pra resolver o pedido
 *
 * Retorna texto pra o webhook enviar via GHL.
 */

import { GHLClient } from "@/lib/ghl/client";
import { trackAndCharge } from "@/lib/billing/charge";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RepIdentity, RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import {
  TERMS_OF_USE_TEXT,
  TERMS_ACCEPTED_TEXT,
  TERMS_REJECTED_TEXT,
  TERMS_REMINDER_TEXT,
  parseTermsResponse,
} from "./terms";
import { acceptTerms, setActiveLocation } from "./identity";
import { buildSparkbotSystemPrompt, buildSparkbotRuntimeContext, loadCarrierTier1 } from "./prompt-builder";
import { runWithTools, type LLMMessage } from "./llm-client";
import { TOOL_REGISTRY, executeTool, type ToolContext } from "./tools";

export interface ProcessInput {
  rep: RepIdentity;
  input: RepInput;
  agentId: string; // agent_id do Sparkbot na Hub location (pra billing/logs)
  /** Turns anteriores da conversa (da sessão de teste ou histórico real do GHL). */
  conversationHistory?: ConversationTurn[];
  /** Quando preenchido, rep está em modo teste — tools de scheduling marcam
   *  o reminder pra disparar nessa session. */
  testSessionId?: string | null;
  config: {
    confirmation_mode?: "always" | "medium_and_high" | "high_only";
    ai_model?: string;
  };
}

export interface ProcessOutput {
  text: string;
  should_send: boolean;
  tokens?: { prompt: number; completion: number; cached: number };
  model_used?: string;
  tools_executed?: string[];
  /** Tool calls completos (input + result) pra debug. Só populado em teste. */
  tool_calls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result: unknown;
  }>;
  /** True se runWithTools retornou stopped_reason='error' ou 'max_iterations'.
   *  Test endpoint deve persistir em metadata pra próximo turno detectar
   *  loop e responder com fallback explícito. */
  llm_failed?: boolean;
}

export async function processIncoming(input: ProcessInput): Promise<ProcessOutput> {
  const { rep } = input;
  const userText = extractUserText(input.input);

  // 1. Termos de uso: se nunca aceitou, manda termos
  if (!rep.terms_accepted_at) {
    const parsed = parseTermsResponse(userText);
    if (parsed === "accept") {
      await acceptTerms(rep.id);
      return { text: TERMS_ACCEPTED_TEXT, should_send: true };
    }
    if (parsed === "reject") {
      return { text: TERMS_REJECTED_TEXT, should_send: true };
    }
    // Primeira msg ou resposta unclear
    // Se nunca respondeu (assume que é primeira msg absoluta), manda termos
    // Se já viu os termos e respondeu unclear, manda reminder
    // Proxy: se display_name e ghl_users já estão populados mas terms null,
    // é primeira msg após identify. Mandamos os termos.
    // Se a msg parece tentar responder (>= 3 chars) e é unclear, manda reminder.
    if (userText.trim().length >= 3) {
      return { text: TERMS_REMINDER_TEXT, should_send: true };
    }
    return { text: TERMS_OF_USE_TEXT, should_send: true };
  }

  // 2. Resolver active_location_id
  if (rep.ghl_users.length === 0) {
    return {
      text: "Não achei seu cadastro em nenhuma location. Fale com o admin da sua agência pra ser autorizado.",
      should_send: true,
    };
  }

  let activeLocationId = rep.active_location_id;
  if (!activeLocationId && rep.ghl_users.length === 1) {
    activeLocationId = rep.ghl_users[0].location_id;
    await setActiveLocation(rep.id, activeLocationId);
  } else if (!activeLocationId && rep.ghl_users.length > 1) {
    // Tenta interpretar a mensagem como escolha de location
    const chosen = rep.ghl_users.find(
      (u) =>
        u.location_name &&
        userText.toLowerCase().includes(u.location_name.toLowerCase()),
    );
    if (chosen) {
      await setActiveLocation(rep.id, chosen.location_id);
      activeLocationId = chosen.location_id;
    } else {
      // Pergunta
      const list = rep.ghl_users
        .map((u, i) => `${i + 1}. ${u.location_name || u.location_id}`)
        .join("\n");
      return {
        text: `Você tá cadastrado em mais de uma location. Em qual quer operar agora?\n${list}\n\nMe manda o número ou o nome.`,
        should_send: true,
      };
    }
  }

  if (!activeLocationId) {
    return { text: "Tive problema identificando sua location.", should_send: true };
  }

  const activeLink = rep.ghl_users.find((u) => u.location_id === activeLocationId)!;

  // 3. Buscar info da location pra timezone + company_id
  const supabase = createAdminClient();
  const { data: location } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name, timezone")
    .eq("location_id", activeLocationId)
    .maybeSingle();

  if (!location) {
    return {
      text: "Não tenho dados dessa location ainda. Pede pro admin fazer login no dashboard primeiro.",
      should_send: true,
    };
  }

  const timezone = location.timezone || "America/New_York";
  // Locale baseado em timezone (pt-BR pro Brasil, en-US pros EUA)
  const locale = timezone.startsWith("America/") && !timezone.includes("Sao_Paulo") && !timezone.includes("Fortaleza") && !timezone.includes("Recife") && !timezone.includes("Manaus") && !timezone.includes("Belem") && !timezone.includes("Bahia")
    ? "en-US"
    : "pt-BR";

  // 4. Build prompt + messages.
  // Carrier Tier 1 carregado em paralelo — chunks priority='always' (~5KB).
  // Se KB vazia ou fail, fica string vazia e seção é omitida.
  const carrierOverview = await loadCarrierTier1("national_life_group").catch((err) => {
    console.warn("[processor] loadCarrierTier1 falhou (não-fatal):", err);
    return "";
  });

  const systemPrompt = buildSparkbotSystemPrompt({
    rep,
    locationName: activeLink.location_name || location.location_name || activeLocationId,
    locationTimezone: timezone,
    locale,
    confirmationMode: input.config.confirmation_mode || "medium_and_high",
    carrierOverview,
  });

  const runtimeContext = buildSparkbotRuntimeContext({
    locationTimezone: timezone,
    locale,
  });

  // Constrói user message (pode ter imagem anexada)
  const userMessage: LLMMessage = buildUserMessage(input.input, runtimeContext);

  // 5. LLM call com tools — prepend histórico da sessão (turns anteriores como
  // user/assistant messages). Alto benefício pra cache hit: turns anteriores
  // são byte-exact estáveis, só o último muda.
  const history: LLMMessage[] = (input.conversationHistory || []).map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const ghlClient = new GHLClient(location.company_id, activeLocationId);
  const toolCtx: ToolContext = {
    rep,
    locationId: activeLocationId,
    companyId: location.company_id,
    ghlClient,
    testSessionId: input.testSessionId || null,
    confirmationMode: input.config.confirmation_mode || "medium_and_high",
  };

  const result = await runWithTools({
    systemPrompt,
    messages: [...history, userMessage],
    tools: Object.values(TOOL_REGISTRY).map((t) => t.def),
    executor: (name, args) => executeTool(name, args, toolCtx),
    model: input.config.ai_model,
  });

  // 5b. Detectar falhas consecutivas de LLM (parse error / max iterations).
  // Igual o sales tem em ai_paused_reason. Pra Sparkbot, conta turns
  // recentes em assistant_test_messages via testSessionId; se 2 falhas
  // seguidas, sinaliza degradado e oferece fallback ao rep em vez de loop.
  const llmFailed =
    result.stopped_reason === "error" || result.stopped_reason === "max_iterations";
  if (llmFailed && input.testSessionId) {
    const supabase2 = createAdminClient();
    const { data: lastAgentMsgs } = await supabase2
      .from("agent_test_messages")
      .select("metadata")
      .eq("session_id", input.testSessionId)
      .eq("role", "agent")
      .order("created_at", { ascending: false })
      .limit(1);
    const lastMeta = (lastAgentMsgs?.[0]?.metadata || {}) as { llm_failed?: boolean };
    if (lastMeta.llm_failed === true) {
      // Segunda falha consecutiva — pausa e devolve mensagem de retry explícita
      console.error(
        `[Sparkbot] 2 LLM failures consecutivas pra rep=${rep.id} session=${input.testSessionId} reason=${result.stopped_reason}`,
      );
      return {
        text:
          "Tô com problema técnico aqui há dois turnos seguidos. Pode tentar de novo daqui a pouco? " +
          "Se persistir, fala com o admin pra checar o sistema.",
        should_send: true,
        model_used: result.model_used,
        tokens: {
          prompt: result.prompt_tokens,
          completion: result.completion_tokens,
          cached: result.cached_tokens,
        },
        tool_calls: result.tool_calls,
        tools_executed: result.tool_calls.map((tc) => tc.name),
      };
    }
  }

  // 6. Billing
  if (result.prompt_tokens > 0) {
    try {
      await trackAndCharge({
        locationId: activeLocationId,
        companyId: location.company_id,
        agentId: input.agentId,
        contactId: rep.id,
        actionType: "account_assistant_turn",
        model: result.model_used,
        promptTokens: result.prompt_tokens,
        completionTokens: result.completion_tokens,
        cachedTokens: result.cached_tokens,
        usesCustomKey: false,
      });
    } catch (err) {
      console.error("[Sparkbot] Billing failed (non-blocking):", err instanceof Error ? err.message : err);
    }
  }

  return {
    text: result.text || "Não consegui gerar resposta. Tenta de novo?",
    should_send: true,
    tokens: {
      prompt: result.prompt_tokens,
      completion: result.completion_tokens,
      cached: result.cached_tokens,
    },
    model_used: result.model_used,
    tools_executed: result.tool_calls.map((tc) => tc.name),
    tool_calls: result.tool_calls,
    llm_failed: llmFailed,
  };
}

/** Extrai texto de qualquer forma de RepInput (pra parsing de termos etc). */
function extractUserText(input: RepInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "audio":
      return input.transcribed_text;
    case "image":
      return input.caption || "";
    case "document":
      return input.extracted_text.substring(0, 500);
  }
}

/** Constrói user message no formato do LLM (suporta imagem multimodal). */
function buildUserMessage(input: RepInput, runtimeContext: string): LLMMessage {
  const header = `${runtimeContext}\n\n`;

  if (input.kind === "text") {
    return { role: "user", content: `${header}${input.text}` };
  }
  if (input.kind === "audio") {
    return {
      role: "user",
      content: `${header}[Rep enviou áudio — transcrição abaixo]\n"${input.transcribed_text}"`,
    };
  }
  if (input.kind === "document") {
    const preview = input.extracted_text.substring(0, 3000);
    return {
      role: "user",
      content: `${header}[Rep enviou documento "${input.filename}" — conteúdo extraído]\n${preview}`,
    };
  }
  // image — multimodal content
  const match = input.base64_data_uri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    return {
      role: "user",
      content: `${header}[Rep enviou imagem mas não consegui processar]${input.caption ? `\nCaption: ${input.caption}` : ""}`,
    };
  }
  return {
    role: "user",
    content: [
      { type: "text", text: `${header}${input.caption || "[Rep enviou imagem]"}` },
      {
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      },
    ],
  };
}
