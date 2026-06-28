import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { GHLClient } from "@/lib/ghl/client";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "@/lib/ai/sales-prompt-builder";
import { formatAvailableSlots } from "@/lib/ai/slots-format";
import { processWithAI } from "@/lib/ai/openai-client";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import { withRetry } from "@/lib/utils/retry";
import { executeActions } from "@/lib/ai/action-executor";

/**
 * POST /api/agents/test
 *
 * Fluxo novo (v2): source of truth é o DB (tabelas agent_test_sessions /
 * agent_test_messages). A UI manda apenas `session_id` + `message`. O backend:
 *
 *   1. Salva a user msg na DB
 *   2. Lê TODO o histórico da sessão do DB (garantido ordenado e completo)
 *   3. Monta prompt igual ao processor de produção
 *   4. Chama IA
 *   5. Salva a agent msg na DB
 *   6. Retorna a agent msg para a UI renderizar
 *
 * Isso elimina os bugs de closure stale / serialização da UI que causavam
 * perda de contexto (histórico incompleto → IA repetia apresentação).
 *
 * Compat legada: se `session_id` não for fornecido, cria uma sessão ad-hoc
 * efêmera (salva no DB mas não lista na UI). Mantém fallback para clients
 * antigos que ainda mandam conversation_history como string.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const {
    agent_id,
    message,
    session_id: providedSessionId,
    collected_data: collectedDataOverride,
    execute_actions: execActions = false,
    contact_id,
    // Legado: alguns clients ainda mandam isso. Se houver session_id, ignora.
    conversation_history: legacyHistory,
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

  // ==========================================================================
  // 1. RESOLVER SESSÃO: usar a fornecida ou criar uma nova.
  // ==========================================================================
  let sessionId: string;
  let sessionCollectedData: Record<string, string> = {};
  let sessionContactId: string | null = contact_id || null;

  if (providedSessionId) {
    const { data: existingSession } = await supabase
      .from("agent_test_sessions")
      .select("id, collected_data, contact_id")
      .eq("id", providedSessionId)
      .eq("location_id", session.locationId)
      .eq("agent_id", agent_id)
      .maybeSingle();

    if (!existingSession) {
      return NextResponse.json({ error: "Sessao nao encontrada" }, { status: 404 });
    }
    sessionId = existingSession.id;
    sessionCollectedData = (existingSession.collected_data as Record<string, string>) || {};
    sessionContactId = existingSession.contact_id || sessionContactId;
  } else {
    // Cria sessão ad-hoc — mantém tudo persistido mesmo sem a UI gerenciar
    const { data: newSession, error: newSessionErr } = await supabase
      .from("agent_test_sessions")
      .insert({
        agent_id,
        location_id: session.locationId,
        created_by: session.userId || "unknown",
        contact_id: sessionContactId,
        session_name: null,
      })
      .select("id")
      .single();

    if (newSessionErr || !newSession) {
      return NextResponse.json({ error: newSessionErr?.message || "Falha ao criar sessao" }, { status: 500 });
    }
    sessionId = newSession.id;
  }

  // ==========================================================================
  // 2. SALVAR A USER MSG (antes de qualquer coisa). Fonte da verdade começa aqui.
  // ==========================================================================
  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "user",
    content: message,
  });

  // ==========================================================================
  // 3. LER TODO O HISTÓRICO DO DB. Esta é a source of truth — nunca mais
  //    confiar no que a UI enviou como string.
  // ==========================================================================
  const { data: dbMessages } = await supabase
    .from("agent_test_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  // A user msg atual acabou de ser inserida — separa do histórico prévio.
  // Aplica cap de 30 últimas mensagens igual ao processor de prod.
  const allMessages = dbMessages || [];
  const priorMessages = allMessages.slice(0, -1).slice(-30);
  const conversationTurns: ConversationTurn[] = priorMessages.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  // Se houver histórico legado (compat) e nenhuma msg prévia no DB, importar
  if (conversationTurns.length === 0 && legacyHistory && typeof legacyHistory === "string") {
    conversationTurns.push(...parseHistoryToTurns(legacyHistory).slice(-30));
  }

  // ==========================================================================
  // 4. BUSCAR LOCATION + SLOTS + CONTATO GHL + CONVSTATE (igual prod)
  // ==========================================================================
  const { data: location } = await supabase
    .from("locations")
    .select("*")
    .eq("location_id", session.locationId)
    .single();

  const locationTz = location?.timezone || "America/New_York";
  const ghlClient = new GHLClient(session.companyId, session.locationId);
  const shouldFetchSlots = !!config.calendar_id && config.objective !== "qualification_only";

  type SlotsResp = Record<string, unknown>;
  type ContactResp = { contact: {
    firstName?: string; lastName?: string; name?: string; email?: string; phone?: string;
    address1?: string; city?: string; state?: string; postalCode?: string; country?: string;
    dateOfBirth?: string; companyName?: string;
    customFields?: { id: string; value: string; fieldKey?: string }[];
  } };

  const slotsNow = new Date();
  const slotsStartDate = String(slotsNow.getTime());
  const slotsEndDate = String(slotsNow.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Se há contact_id, também buscamos o histórico real do GHL. Isso é crítico
  // pra "modo continuação": se o lead já conversou em prod, a IA entra como
  // continuação (sem reapresentar), não como primeira mensagem.
  type GhlConversationSearch = { conversations: { id: string }[] };
  type GhlMessagesResp = {
    messages: { messages: { direction: string; body?: string; dateAdded: string; messageType?: string }[] };
  };

  const [slotsSettled, contactSettled, convStateResult, ghlMessagesCountSettled] = await Promise.allSettled([
    shouldFetchSlots
      ? // F43 (Pedro 2026-06-02): deadline duro de 10s na busca de slots. O
        // test chat é SÍNCRONO (rep encara "digitando…") — não pode travar 2min
        // se o free-slots do GHL pendurar. Se estourar, vira rejected → cai no
        // slotsFetchFailed=true (prompt degrada com slotsUnavailable). Em prod
        // (queue-processor) o caminho é async, então lá não tem esse race —
        // mas o teto de 20s do GHLClient (F43) já evita hang infinito.
        Promise.race([
          withRetry(
            () => ghlClient.get<SlotsResp>(
              `/calendars/${config.calendar_id}/free-slots`,
              { startDate: slotsStartDate, endDate: slotsEndDate },
            ),
            { maxRetries: 1, baseDelayMs: 200, label: "test:free-slots" },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("free-slots deadline 10s (test chat)")), 10_000),
          ),
        ])
      : Promise.resolve<SlotsResp | null>(null),
    sessionContactId
      ? ghlClient.get<ContactResp>(`/contacts/${sessionContactId}`)
      : Promise.resolve<ContactResp | null>(null),
    sessionContactId
      ? supabase
          .from("conversation_state")
          .select("collected_data, conversation_id")
          .eq("agent_id", agent_id)
          .eq("contact_id", sessionContactId)
          .maybeSingle()
      : Promise.resolve<{ data: { collected_data?: Record<string, string>; conversation_id?: string } | null } | null>(null),
    // Fetch histórico real do GHL só para CONTAR turnos (não entra no prompt).
    // Só roda se tiver contact_id — pra teste sem contato real, skipa.
    sessionContactId
      ? (async () => {
          try {
            const searchResult = await ghlClient.get<GhlConversationSearch>(
              "/conversations/search",
              { locationId: session.locationId, contactId: sessionContactId },
            );
            const convId = searchResult.conversations?.[0]?.id;
            if (!convId) return 0;
            const msgs = await ghlClient.get<GhlMessagesResp>(
              `/conversations/${convId}/messages`,
              { locationId: session.locationId },
            );
            return (msgs.messages?.messages || [])
              .filter((m) => m.messageType === "TYPE_CUSTOM_SMS" || m.body)
              .length;
          } catch {
            return 0;
          }
        })()
      : Promise.resolve(0),
  ]);

  // Processar slots
  let availableSlots = "";
  let slotsFetchFailed = false;
  if (shouldFetchSlots) {
    if (slotsSettled.status === "fulfilled" && slotsSettled.value) {
      // F48: mesmo formatter do runtime de prod (paridade) — dia inteiro,
      // sempre com o último horário real (sem o slice(0,8) que fazia o agente
      // mentir sobre disponibilidade da noite).
      availableSlots = formatAvailableSlots(slotsSettled.value as Record<string, unknown>, locationTz);
    } else {
      slotsFetchFailed = true;
      console.error(`[Test FreeSlots] All retries failed:`,
        slotsSettled.status === "rejected"
          ? (slotsSettled.reason instanceof Error ? slotsSettled.reason.message : slotsSettled.reason)
          : "unknown",
      );
    }
  }

  // Processar contato GHL
  const contactDataFromGhl: Record<string, string> = {};
  let ghlContactName: string | undefined;
  if (contactSettled.status === "fulfilled" && contactSettled.value?.contact) {
    const c = contactSettled.value.contact;
    ghlContactName = c.name || c.firstName;
    if (c.firstName) contactDataFromGhl["contact.firstName"] = c.firstName;
    if (c.lastName) contactDataFromGhl["contact.lastName"] = c.lastName;
    if (c.name) contactDataFromGhl["contact.name"] = c.name;
    if (c.email) contactDataFromGhl["contact.email"] = c.email;
    if (c.phone) contactDataFromGhl["contact.phone"] = c.phone;
    if (c.address1) contactDataFromGhl["contact.address1"] = c.address1;
    if (c.city) contactDataFromGhl["contact.city"] = c.city;
    if (c.state) contactDataFromGhl["contact.state"] = c.state;
    if (c.postalCode) contactDataFromGhl["contact.postalCode"] = c.postalCode;
    if (c.country) contactDataFromGhl["contact.country"] = c.country;
    if (c.dateOfBirth) contactDataFromGhl["contact.dateOfBirth"] = c.dateOfBirth;
    if (c.companyName) contactDataFromGhl["contact.companyName"] = c.companyName;
    if (c.customFields) {
      for (const cf of c.customFields) {
        if (cf.value) {
          contactDataFromGhl[cf.id] = cf.value;
          if (cf.fieldKey) contactDataFromGhl[cf.fieldKey] = cf.value;
        }
      }
    }
  }

  const previousCollectedData =
    convStateResult.status === "fulfilled" && convStateResult.value && "data" in convStateResult.value
      ? (convStateResult.value.data?.collected_data as Record<string, string> | undefined) || {}
      : {};

  // Merge alinhado com prod: GHL (base) → convState → sessão de teste.
  // O override da UI só sobrescreve com VALORES NÃO-VAZIOS, pra não apagar
  // dados reais com strings vazias que a UI eventualmente mande.
  const nonEmptyOverride: Record<string, string> = {};
  if (collectedDataOverride && typeof collectedDataOverride === "object") {
    for (const [k, v] of Object.entries(collectedDataOverride)) {
      const val = String(v || "").trim();
      if (val) nonEmptyOverride[k] = val;
    }
  }
  const mergedCollectedData = {
    ...contactDataFromGhl,
    ...previousCollectedData,
    ...sessionCollectedData,
    ...nonEmptyOverride,
  };

  const currentDateInTz = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: locationTz,
  });
  const currentTimeInTz = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: locationTz,
  });

  const { data: feedbackData } = await supabase
    .from("agent_feedback")
    .select("rating, ai_message, suggestion")
    .eq("agent_id", agent_id)
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: kbData } = await supabase
    .from("knowledge_base")
    .select("title, type, content, file_name, file_url, description, usage_instructions")
    .eq("agent_id", agent_id)
    .order("created_at", { ascending: true });

  const knowledgeBase = (kbData || []) as import("@/lib/ai/sales-prompt-builder").KnowledgeBaseItem[];

  // contactName: usa nome real do GHL ou do collected_data. NUNCA placeholder
  // tipo "Usuário Teste" — isso aparecia literal em {contact.name}, estragava
  // a personalização do prompt e induzia a IA a comportamento de "lead novo".
  const collectedName = mergedCollectedData["contact.name"] || mergedCollectedData["full_name"];
  const resolvedContactName = ghlContactName || collectedName || "";

  // priorTurnCount alinhado com prod: conta tanto turnos da sessão de teste
  // QUANTO histórico real do lead no GHL. Se o lead já conversou 20x no
  // WhatsApp, a IA no teste trata como continuação (não se apresenta de novo).
  const ghlRealTurnCount = ghlMessagesCountSettled.status === "fulfilled"
    ? Math.min(30, ghlMessagesCountSettled.value)
    : 0;
  const effectivePriorTurnCount = Math.max(conversationTurns.length, ghlRealTurnCount);

  const promptCtx = {
    config,
    // custom_agent testa no caminho de lead provado, com framing NEUTRO (C2-4) —
    // espelha exatamente o queue-processor de prod (tipo real, não força sales).
    agentType: (agent.type === "recruitment_agent"
      ? "recruitment_agent"
      : agent.type === "custom_agent"
        ? "custom_agent"
        : "sales_agent") as "sales_agent" | "recruitment_agent" | "custom_agent",
    contactName: resolvedContactName,
    collectedData: mergedCollectedData,
    locationName: location?.location_name || "Minha Empresa",
    currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
    timezone: locationTz,
    availableSlots,
    slotsUnavailable: slotsFetchFailed,
    knowledgeBase: knowledgeBase.length > 0 ? knowledgeBase : undefined,
    feedback: feedbackData as { rating: "positive" | "negative"; ai_message: string; suggestion?: string }[] || [],
    priorTurnCount: effectivePriorTurnCount,
  };
  const systemPrompt = buildSystemPrompt(promptCtx);
  const runtimeContext = buildRuntimeContext(promptCtx);
  const responseSchema = buildResponseJsonSchema(promptCtx);

  // ==========================================================================
  // 5. CHAMAR A IA
  // ==========================================================================
  const result = await processWithAI({
    systemPrompt,
    runtimeContext,
    conversationMessages: conversationTurns,
    conversationHistory: "",
    newMessages: message,
    model: config.ai_model || "claude-sonnet-4-6",
    responseSchema,
    // Fix HIGH-1 (deep review 2026-05-05): usar effectivePriorTurnCount aqui
    // tb (já era usado no buildSystemPrompt acima). Antes só conversationTurns
    // era passado pra processWithAI/sanitizer — se lead tinha 20 msgs reais
    // no GHL mas test session vazia, sanitizer tratava como 1ª msg → não
    // strippava saudação ("Oi, sou Maria...") apesar do prompt instruir.
    priorTurnCount: effectivePriorTurnCount,
  });

  if (!result.success || !result.response) {
    return NextResponse.json(
      { error: result.error || "Falha no processamento", session_id: sessionId },
      { status: 500 }
    );
  }

  // ==========================================================================
  // 6. SALVAR A AGENT MSG NO DB. Próximo turno vai vê-la automaticamente.
  // ==========================================================================
  const agentContent = Array.isArray(result.response.message)
    ? result.response.message.join("\n")
    : result.response.message;

  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "agent",
    content: agentContent,
    metadata: {
      prompt_tokens: result.prompt_tokens,
      completion_tokens: result.completion_tokens,
      cached_tokens: result.cached_tokens,
      duration_ms: result.duration_ms,
      actions: result.response.actions || [],
      conversation_status: result.response.conversation_status,
    },
  });

  // Atualizar collected_data da sessão (acumulativo)
  if (result.response.collected_data && Object.keys(result.response.collected_data).length > 0) {
    const mergedSessionData = { ...sessionCollectedData, ...result.response.collected_data };
    await supabase
      .from("agent_test_sessions")
      .update({ collected_data: mergedSessionData })
      .eq("id", sessionId);
  }

  // ==========================================================================
  // 7. EXECUTAR AÇÕES REAIS (fire-and-forget via waitUntil, igual webhook de prod).
  //    Evita que a UI do teste fique bloqueada esperando calls ao GHL.
  // ==========================================================================
  const actionsScheduled = !!(execActions && sessionContactId && result.response);

  if (actionsScheduled) {
    waitUntil(
      (async () => {
        try {
          await executeActions(result.response!, {
            companyId: session.companyId,
            locationId: session.locationId,
            contactId: sessionContactId!,
            agentId: agent_id,
            conversationId: `test-${sessionId}`,
            calendarId: config.calendar_id || undefined,
            skipSendMessage: true,
            testMode: true,
            requireContactBeforeBooking: !!config.post_booking?.require_contact_before_booking,
            collectedData: result.response?.collected_data || {},
          });
        } catch (error) {
          console.error("[Test ExecuteActions] Falha em background:", error instanceof Error ? error.message : error);
        }
      })(),
    );
  }

  return NextResponse.json({
    session_id: sessionId,
    response: result.response,
    prompt_tokens: result.prompt_tokens,
    completion_tokens: result.completion_tokens,
    duration_ms: result.duration_ms,
    actions_scheduled: actionsScheduled,
    available_slots: availableSlots || null,
  });
}

/**
 * Converte o formato legado "LEAD: x\nAGENTE: y" em turns estruturados.
 * Mantido apenas para compat com clients que ainda enviem conversation_history.
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
      turns[turns.length - 1].content += "\n" + line;
    }
  }
  return turns.filter((t) => t.content.trim().length > 0);
}
