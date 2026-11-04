import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { GHLClient } from "@/lib/ghl/client";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "@/lib/ai/sales-prompt-builder";
import { formatAvailableSlots, filterSlotsToBusinessHours } from "@/lib/ai/slots-format";
import { extractSlotIsoList } from "@/lib/ai/slot-guard";
import { aplicarGuardasDeAgenda } from "@/lib/queue/agenda-guard";
import { detectarFusoNoTexto, fusoDoEstado } from "@/lib/queue/lead-timezone";
import { processWithAI } from "@/lib/ai/openai-client";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import { withRetry } from "@/lib/utils/retry";
import { executeActions } from "@/lib/ai/action-executor";
import { evaluateLeadSilence, stripSilenceMarker } from "@/lib/ai/lead-silence";
import { resolveForbiddenTerms } from "@/lib/ai/outbound-sanitizer";
import { isChatMessageType } from "@/lib/ghl/message-sources";
import { lerTokenMarina } from "@/lib/marina-lab/auth";
import { lerTokenAlves } from "@/lib/alves-lab/auth";
import { slotWindowDays } from "@/lib/queue/slot-window";
import { aplicarGuardaDeDataLead } from "@/lib/queue/lead-day-guard";
import { turnRepeatVerdict, stripRepeatedAsks } from "@/lib/queue/followup-repeat-guard";
import { loadLeadHistory, invalidateLeadHistoryCache } from "@/lib/queue/lead-history";
import { getLeadHistoryConfig } from "@/types/agent";
import { agendaLiberadaPorEtiqueta, etiquetasDoContato } from "@/lib/queue/booking-tag-gate";

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
  const body = await request.json();

  // Marina Lab (2026-08-26, temporário — `_planning/marina-lab/PLANO.md`): a
  // Marina testa o agente DELA por uma página com senha própria, sem SSO do
  // Spark Leads. O escopo vem do TOKEN (agent_id + location), nunca do body —
  // então essa senha não vira chave pra cutucar agente de outra conta. Some
  // com MARINA_LAB_ENABLED=0.
  let session = await getSession();
  if (!session) {
    const marina = await lerTokenMarina(request);
    if (marina && body?.agent_id === marina.agent_id) {
      session = {
        userId: "marina-lab",
        locationId: marina.location_id,
        companyId: marina.company_id,
        locationName: "Marina's Personal Account",
        isAdmin: false,
      } as Awaited<ReturnType<typeof getSession>>;
    }
  }
  // Alves Lab (2026-08-31, temporário — teste pré-religa pós-H88): mesmo
  // desenho do Marina Lab, com PIN. O token carrega os DOIS agentes da conta
  // (Bruna e Bruno); qualquer outro agent_id no body continua 401.
  if (!session) {
    const alves = await lerTokenAlves(request);
    if (alves && typeof body?.agent_id === "string" && alves.agent_ids.includes(body.agent_id)) {
      session = {
        userId: "alves-lab",
        locationId: alves.location_id,
        companyId: alves.company_id,
        locationName: "Alves Cury Financial",
        isAdmin: false,
      } as Awaited<ReturnType<typeof getSession>>;
    }
  }
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

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

  const configSalva = Array.isArray(agent.agent_configs)
    ? agent.agent_configs[0]
    : agent.agent_configs;

  if (!configSalva) {
    return NextResponse.json({ error: "Agente sem configuracao" }, { status: 400 });
  }

  // H116 (Alves Cury 04/11/2026): testar instruções ANTES de salvar. O teste só
  // conseguia rodar a config gravada, e gravar instrução nova para testar é
  // testar em lead real. `config_override` vale só nesta chamada, nunca é
  // persistido, e só para o laboratório da conta ou admin. Campos de TEXTO do
  // agente apenas (nada de agenda, gatilho ou canal).
  const overrideBruto = (body as { config_override?: unknown }).config_override;
  const podeSobrescrever = session.userId === "alves-lab" || session.userId === "marina-lab" || !!session.isAdmin;
  const config = (() => {
    if (!podeSobrescrever || !overrideBruto || typeof overrideBruto !== "object") return configSalva;
    const o = overrideBruto as Record<string, unknown>;
    const out = { ...configSalva } as typeof configSalva & Record<string, unknown>;
    if (typeof o.custom_instructions === "string") out.custom_instructions = o.custom_instructions;
    if (typeof o.conversation_examples === "string") out.conversation_examples = o.conversation_examples;
    if (o.personality && typeof o.personality === "object") {
      out.personality = { ...((configSalva.personality as Record<string, unknown>) || {}), ...(o.personality as Record<string, unknown>) } as typeof configSalva.personality;
    }
    return out as typeof configSalva;
  })();

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
    // H112: etiquetas pra trava de agenda (mesmo GET, zero chamada extra).
    tags?: Array<string | { name?: string }>;
  } };

  const slotsNow = new Date();
  const slotsStartDate = String(slotsNow.getTime());
  // H80: espelha o queue-processor — o teste tem que enxergar a MESMA janela de slots.
  const slotsEndDate = String(
    slotsNow.getTime() + slotWindowDays(config as { slot_window_days?: number | null }) * 24 * 60 * 60 * 1000,
  );

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
              // Paridade com prod (fix 2026-07-28): atividade do CRM/ligação fora.
              .filter((m) => isChatMessageType(m.messageType))
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
  let slotsNaJanelaTeste: Record<string, unknown> | null = null;
  let offeredSlotsIsoTeste: string[] | undefined;
  if (shouldFetchSlots) {
    if (slotsSettled.status === "fulfilled" && slotsSettled.value) {
      // F48: mesmo formatter do runtime de prod (paridade) — dia inteiro,
      // sempre com o último horário real (sem o slice(0,8) que fazia o agente
      // mentir sobre disponibilidade da noite).
      // H115: paridade com o processor. Mesmo filtro de expediente e a lista ISO
      // que alimenta a guarda de agenda; a formatação sai mais abaixo, quando o
      // fuso do lead já é conhecido.
      slotsNaJanelaTeste = filterSlotsToBusinessHours(slotsSettled.value as Record<string, unknown>, locationTz);
      offeredSlotsIsoTeste = extractSlotIsoList(slotsNaJanelaTeste);
      availableSlots = formatAvailableSlots(slotsNaJanelaTeste, locationTz);
    } else {
      offeredSlotsIsoTeste = [];
      slotsFetchFailed = true;
      console.error(`[Test FreeSlots] All retries failed:`,
        slotsSettled.status === "rejected"
          ? (slotsSettled.reason instanceof Error ? slotsSettled.reason.message : slotsSettled.reason)
          : "unknown",
      );
    }
  }

  // H112: paridade com o processor. Sem a etiqueta exigida pela trava de agenda,
  // o teste também não entrega horário ao modelo.
  let agendaTravadaTeste = false;
  if (sessionContactId && shouldFetchSlots) {
    const veredito = agendaLiberadaPorEtiqueta(
      (config as { booking_tag_gate?: unknown }).booking_tag_gate,
      etiquetasDoContato(contactSettled.status === "fulfilled" ? contactSettled.value?.contact : null),
    );
    if (!veredito.liberada) {
      agendaTravadaTeste = true;
      availableSlots = "";
      offeredSlotsIsoTeste = [];
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

  // H111 (2026-11-03): paridade com o queue-processor. Sem o histórico do lead,
  // o teste não via as etiquetas do contato, e a regra "só agenda com a etiqueta
  // de 70% do vídeo" (Alves Cury) não tinha como ser testada aqui.
  const leadHistoryCfgTeste = getLeadHistoryConfig(
    config as { lead_history_config?: import("@/types/agent").LeadHistoryConfig | null },
  );
  // Paridade com o processor (P1, review 2026-06-05): invalida o cache de 5 min a
  // cada turno. Sem isso o teste via etiqueta velha depois de alguém mexer no
  // contato (medido em 03/11: tirei "video completo" e o Bruno seguiu vendo).
  if (sessionContactId) invalidateLeadHistoryCache(sessionContactId);
  const leadHistoryTeste =
    leadHistoryCfgTeste.enabled && sessionContactId
      ? await loadLeadHistory(sessionContactId, session.companyId, session.locationId, leadHistoryCfgTeste, locationTz).catch(() => undefined)
      : undefined;
  const cacheOptimizedTeste = process.env.LEAD_CACHE_OPTIMIZED === "1";

  // H115: fuso do lead (paridade com o processor).
  let fusoLeadTeste: { tz: string; origem: string } | null = null;
  if ((config as { timezone_config?: { auto_detect_from_state?: boolean } | null }).timezone_config?.auto_detect_from_state) {
    const estado =
      mergedCollectedData["contact.state"] || mergedCollectedData["state"] || mergedCollectedData["estado_onde_mora"] || mergedCollectedData["estado"] || "";
    fusoLeadTeste = fusoDoEstado(estado) ?? detectarFusoNoTexto(message || "");
  }
  if (slotsNaJanelaTeste && !agendaTravadaTeste && fusoLeadTeste) {
    availableSlots = formatAvailableSlots(slotsNaJanelaTeste, locationTz, 30, fusoLeadTeste.tz);
  }

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
    contactId: sessionContactId ?? undefined,
    collectedData: mergedCollectedData,
    locationName: location?.location_name || "Minha Empresa",
    currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
    timezone: locationTz,
    availableSlots,
    slotsUnavailable: slotsFetchFailed,
    agendaTravada: agendaTravadaTeste,
    fusoLead: fusoLeadTeste,
    knowledgeBase: knowledgeBase.length > 0 ? knowledgeBase : undefined,
    feedback: feedbackData as { rating: "positive" | "negative"; ai_message: string; suggestion?: string }[] || [],
    priorTurnCount: effectivePriorTurnCount,
    leadHistory: leadHistoryTeste,
    cacheOptimized: cacheOptimizedTeste,
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

  // H88 rodada 2 — paridade com o queue-processor (regra do gate de paridade do
  // CLAUDE.md): 3ª ocorrência da MESMA pergunta na conversa é bloqueada — 1
  // regeneração com diretiva; se repetir, a re-pergunta é removida.
  {
    const assistantPrior = conversationTurns.filter((t) => t.role === "assistant").map((t) => t.content);
    const bolhasCand = Array.isArray(result.response.message)
      ? result.response.message.filter((m): m is string => typeof m === "string")
      : result.response.message
        ? [String(result.response.message)]
        : [];
    if (bolhasCand.join("").trim() && assistantPrior.length >= 2) {
      const veredito = turnRepeatVerdict(bolhasCand.join("\n"), assistantPrior);
      if (veredito.repeated) {
        const retryRepeat = await processWithAI({
          systemPrompt,
          runtimeContext,
          conversationMessages: conversationTurns,
          conversationHistory: "",
          newMessages:
            message +
            `\n\n[SISTEMA: você JÁ perguntou isso ${veredito.occurrences} vezes nesta conversa sem resposta: "${(veredito.matched || "").slice(0, 160)}". PROIBIDO perguntar de novo em qualquer formulação. Responda o que o lead trouxe e SIGA o fluxo sem esse dado. Mesmo formato JSON.]`,
          model: config.ai_model || "claude-sonnet-4-6",
          responseSchema,
          priorTurnCount: effectivePriorTurnCount,
        });
        const retryBolhas =
          retryRepeat.success && retryRepeat.response && !retryRepeat.parse_failed
            ? Array.isArray(retryRepeat.response.message)
              ? retryRepeat.response.message.filter((m): m is string => typeof m === "string")
              : retryRepeat.response.message
                ? [String(retryRepeat.response.message)]
                : []
            : [];
        if (retryBolhas.length > 0 && !turnRepeatVerdict(retryBolhas.join("\n"), assistantPrior).repeated && retryRepeat.response) {
          result.response.message = retryRepeat.response.message;
          if (retryRepeat.response.actions) result.response.actions = retryRepeat.response.actions;
        } else {
          const strip = stripRepeatedAsks(bolhasCand, assistantPrior);
          if (strip.stripped && strip.messages.length > 0) result.response.message = strip.messages;
        }
      }
    }
  }

  // H115: guardas de agenda (paridade com o processor; ver agenda-guard.ts).
  let agendaGuardTeste: { notas: string[]; regenerou: boolean; oferta_substituida: boolean; agendamento_retirado: boolean } | null = null;
  if (!result.parse_failed && result.response) {
    const g = await aplicarGuardasDeAgenda({
      resposta: result.response,
      slotsIso: shouldFetchSlots ? (offeredSlotsIsoTeste ?? []) : undefined,
      fusoLista: locationTz,
      fusoLead: fusoLeadTeste?.tz ?? null,
      mensagemDoLead: message || "",
      // Paridade: em prod, conversa já agendada não confere oferta (citar a
      // reunião marcada é legítimo). O teste não grava agendamento, então confere sempre.
      pularOferta: false,
      preferirTardeNoite: (config as { preferred_time_slot?: string | null }).preferred_time_slot === "afternoon_evening",
      regenerar: async (diretiva) => {
        const r = await processWithAI({
          systemPrompt,
          runtimeContext,
          conversationMessages: conversationTurns,
          conversationHistory: "",
          newMessages: message + "\n\n" + diretiva,
          model: config.ai_model || "claude-sonnet-4-6",
          responseSchema,
          priorTurnCount: effectivePriorTurnCount,
        });
        return r.success && r.response && !r.parse_failed ? r.response : null;
      },
    });
    if (g.notas.length > 0) {
      result.response = g.resposta;
      agendaGuardTeste = {
        notas: g.notas,
        regenerou: g.regenerou,
        oferta_substituida: g.ofertaSubstituida,
        agendamento_retirado: g.agendamentoRetirado,
      };
    }
  }

  // ==========================================================================
  // 6. SALVAR A AGENT MSG NO DB. Próximo turno vai vê-la automaticamente.
  // ==========================================================================
  // MC-9: paridade do gate de silêncio com prod — MESMA decisão do queue-processor
  // (regra do gate de paridade do CLAUDE.md: sem isto, validar o silêncio no test
  // chat antes de ligar a flag seria impossível).
  const silenceDecision = evaluateLeadSilence({
    shouldSendMessage: result.response.should_send_message,
    message: result.response.message,
    inboundText: message || "",
    priorTurnCount: effectivePriorTurnCount,
    allowSilence: (config as { allow_silent_turns?: boolean }).allow_silent_turns === true,
  });

  const strippedMsg = stripSilenceMarker(result.response.message);
  const agentContent = silenceDecision.silent
    ? ""
    : Array.isArray(strippedMsg)
      ? strippedMsg.join("\n")
      : strippedMsg;

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
      ...(silenceDecision.silent ? { suppressed: true, silence_via: silenceDecision.via } : {}),
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
            forbiddenTerms: resolveForbiddenTerms(agent_id, config.forbidden_terms),
            timezone: locationTz, // paridade H66 com o processor
            offeredSlotsIso: offeredSlotsIsoTeste,
            fusoLead: fusoLeadTeste?.tz ?? undefined,
            agentLabel: (config.personality as { name?: string } | null)?.name || undefined,
          });
        } catch (error) {
          console.error("[Test ExecuteActions] Falha em background:", error instanceof Error ? error.message : error);
        }
      })(),
    );
  }

  // Guarda de data lead-facing (paridade com o envio real — caso Alves Cury
  // 2026-08-31): o texto EXIBIDO no teste passa pelo mesmo guard determinístico
  // de dia/data do executor, senão o stress valida um texto que prod corrige.
  if (result.response?.message) {
    const bolhas = (Array.isArray(result.response.message)
      ? result.response.message
      : [String(result.response.message)]
    ).filter((b): b is string => typeof b === "string" && !!b.trim());
    if (bolhas.length > 0) {
      const dg = aplicarGuardaDeDataLead(bolhas, locationTz);
      if (dg.changed) result.response.message = dg.messages;
    }
  }

  return NextResponse.json({
    session_id: sessionId,
    response: result.response,
    // MC-9: decisão de silêncio pro chip da UI ("Decidiu ficar em silêncio").
    silence: silenceDecision,
    prompt_tokens: result.prompt_tokens,
    completion_tokens: result.completion_tokens,
    duration_ms: result.duration_ms,
    actions_scheduled: actionsScheduled,
    available_slots: availableSlots || null,
    // H115: o que a guarda de agenda fez neste turno (null = nada).
    agenda_guard: agendaGuardTeste,
    model_used: result.model_used ?? null,
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
