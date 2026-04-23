import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { GHLClient } from "@/lib/ghl/client";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "@/lib/ai/prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import { executeActions } from "@/lib/ai/action-executor";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const {
    agent_id,
    message,
    conversation_history,
    collected_data,
    execute_actions: execActions = false,
    contact_id,
  } = body;

  if (!agent_id || !message) {
    return NextResponse.json({ error: "agent_id e message obrigatorios" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("*, agent_configs(*)")
    .eq("id", agent_id)
    .eq("location_id", session.locationId)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  const config = Array.isArray(agent.agent_configs)
    ? agent.agent_configs[0]
    : agent.agent_configs;

  if (!config) {
    return NextResponse.json({ error: "Agente sem configuracao" }, { status: 400 });
  }

  const { data: location } = await supabase
    .from("locations")
    .select("*")
    .eq("location_id", session.locationId)
    .single();

  const locationTz = location?.timezone || "America/New_York";

  // Buscar free slots do calendario (igual ao processador principal)
  let availableSlots = "";
  console.log(`[Test] calendar_id=${config.calendar_id}, objective=${config.objective}`);
  if (config.calendar_id && config.objective !== "qualification_only") {
    try {
      const ghlClient = new GHLClient(session.companyId, session.locationId);
      const now = new Date();
      const startDate = String(now.getTime());
      const endDate = String(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      console.log(`[Test FreeSlots] Fetching: calendar=${config.calendar_id}, start=${startDate}, end=${endDate}`);

      const slotsResult = await ghlClient.get<Record<string, unknown>>(
        `/calendars/${config.calendar_id}/free-slots`,
        { startDate, endDate }
      );

      console.log(`[Test FreeSlots] Response keys: ${Object.keys(slotsResult).join(", ")}`);
      console.log(`[Test FreeSlots] Sample:`, JSON.stringify(slotsResult).substring(0, 500));

      const slotLines: string[] = [];
      for (const [key, value] of Object.entries(slotsResult)) {
        if (key === "traceId" || !value) continue;

        let slots: string[] = [];
        if (typeof value === "object" && value !== null) {
          const v = value as Record<string, unknown>;
          if (Array.isArray(v.slots)) {
            slots = v.slots as string[];
          } else if (Array.isArray(value)) {
            slots = value as string[];
          }
        }

        if (slots.length === 0) continue;

        const dateFormatted = new Date(key + "T12:00:00").toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric", timeZone: locationTz,
        });

        const slotsFormatted = slots.slice(0, 8).map((s: string) => {
          return new Date(s).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", hour12: true, timeZone: locationTz,
          });
        });

        slotLines.push(`${dateFormatted}: ${slotsFormatted.join(", ")}`);
      }
      availableSlots = slotLines.join("\n");
      console.log(`[Test FreeSlots] Formatted ${slotLines.length} days, slots: ${availableSlots.substring(0, 200)}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("[Test] Erro ao buscar free slots:", errMsg);
      availableSlots = "";
    }
  }

  // Data/hora no timezone correto
  const currentDateInTz = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: locationTz,
  });
  const currentTimeInTz = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: locationTz,
  });

  // Buscar feedback
  const { data: feedbackData } = await supabase
    .from("agent_feedback")
    .select("rating, ai_message, suggestion")
    .eq("agent_id", agent_id)
    .order("created_at", { ascending: false })
    .limit(20);

  // Buscar knowledge base
  const { data: kbData } = await supabase
    .from("knowledge_base")
    .select("title, type, content, file_name, file_url, description, usage_instructions")
    .eq("agent_id", agent_id)
    .order("created_at", { ascending: true });

  const knowledgeBase = (kbData || []) as import("@/lib/ai/prompt-builder").KnowledgeBaseItem[];

  // Converter history string "LEAD: x\nAGENTE: y" em turns estruturados.
  // Isso evita que o modelo interprete o bloco como exemplo e repita saudação.
  const conversationTurns = parseHistoryToTurns(conversation_history || "");

  const promptCtx = {
    config,
    agentType: agent.type as "sales_agent" | "recruitment_agent",
    contactName: contact_id ? "Lead" : "Usuário Teste",
    collectedData: collected_data || {},
    locationName: location?.location_name || "Minha Empresa",
    currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
    timezone: locationTz,
    availableSlots,
    knowledgeBase: knowledgeBase.length > 0 ? knowledgeBase : undefined,
    feedback: feedbackData as { rating: "positive" | "negative"; ai_message: string; suggestion?: string }[] || [],
    priorTurnCount: conversationTurns.length,
  };
  const systemPrompt = buildSystemPrompt(promptCtx);
  const runtimeContext = buildRuntimeContext(promptCtx);
  const responseSchema = buildResponseJsonSchema(promptCtx);

  const result = await processWithAI({
    systemPrompt,
    runtimeContext,
    conversationMessages: conversationTurns,
    conversationHistory: "",
    newMessages: message,
    model: config.ai_model || "gpt-4.1-mini",
    responseSchema,
  });

  if (!result.success || !result.response) {
    return NextResponse.json(
      { error: result.error || "Falha no processamento" },
      { status: 500 }
    );
  }

  // Executar acoes reais se solicitado
  let actionsExecuted = false;
  let actionsError: string | null = null;

  if (execActions && contact_id && result.response) {
    try {
      await executeActions(result.response, {
        companyId: session.companyId,
        locationId: session.locationId,
        contactId: contact_id,
        agentId: agent_id,
        conversationId: `test-${Date.now()}`,
        calendarId: config.calendar_id || undefined,
        skipSendMessage: true,
        testMode: true,
      });
      actionsExecuted = true;
    } catch (error) {
      actionsError = error instanceof Error ? error.message : "Erro ao executar acoes";
    }
  }

  return NextResponse.json({
    response: result.response,
    prompt_tokens: result.prompt_tokens,
    completion_tokens: result.completion_tokens,
    duration_ms: result.duration_ms,
    actions_executed: actionsExecuted,
    actions_error: actionsError,
    available_slots: availableSlots || null,
  });
}

/**
 * Converte o formato legado "LEAD: x\nAGENTE: y" em turns estruturados.
 * Linhas que não começam com LEAD:/AGENTE: são anexadas à mensagem anterior
 * (mensagens multi-linha). Mensagens vazias são descartadas.
 */
function parseHistoryToTurns(history: string): ConversationTurn[] {
  if (!history || !history.trim()) return [];
  const turns: ConversationTurn[] = [];
  const lines = history.split("\n");
  for (const line of lines) {
    const leadMatch = line.match(/^LEAD:\s*(.*)$/);
    const agentMatch = line.match(/^AGENTE:\s*(.*)$/);
    if (leadMatch) {
      turns.push({ role: "user", content: leadMatch[1] });
    } else if (agentMatch) {
      turns.push({ role: "assistant", content: agentMatch[1] });
    } else if (turns.length > 0) {
      // Linha de continuação — anexa na última
      turns[turns.length - 1].content += "\n" + line;
    }
  }
  return turns.filter((t) => t.content.trim().length > 0);
}
