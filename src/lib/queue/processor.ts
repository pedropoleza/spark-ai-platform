import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { buildSystemPrompt } from "@/lib/ai/prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import { executeActions } from "@/lib/ai/action-executor";
import { scheduleFollowUps } from "@/lib/queue/follow-up-scheduler";
import { trackAndCharge } from "@/lib/billing/charge";
import type { GHLMessage } from "@/types/ghl";

interface QueuedMessage {
  id: string;
  location_id: string;
  contact_id: string;
  conversation_id: string;
  message_body: string;
  channel?: string;
}

interface MessageGroup {
  locationId: string;
  contactId: string;
  conversationId: string;
  channel: string;
  messages: QueuedMessage[];
  aggregatedBody: string;
}

/**
 * Processa todas as mensagens prontas na fila
 */
export async function processMessageQueue(): Promise<{
  processed: number;
  errors: number;
}> {
  const supabase = createAdminClient();
  let processed = 0;
  let errors = 0;

  // 1. ATOMIC: Marcar como "processing" e retornar em uma operação
  // Isso evita race condition onde dois workers pegam a mesma mensagem
  const { data: pendingMessages, error: fetchError } = await supabase
    .from("message_queue")
    .update({ status: "processing" })
    .eq("status", "pending")
    .lte("process_after", new Date().toISOString())
    .select("*")
    .order("received_at", { ascending: true })
    .limit(100);

  if (fetchError || !pendingMessages || pendingMessages.length === 0) {
    return { processed: 0, errors: 0 };
  }

  // 3. Agrupar por (location_id, contact_id)
  const groups = new Map<string, MessageGroup>();

  for (const msg of pendingMessages) {
    const key = `${msg.location_id}:${msg.contact_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        locationId: msg.location_id,
        contactId: msg.contact_id,
        conversationId: msg.conversation_id,
        channel: msg.channel || "SMS",
        messages: [],
        aggregatedBody: "",
      });
    }
    groups.get(key)!.messages.push(msg);
  }

  // Agregar bodies
  for (const group of Array.from(groups.values())) {
    group.aggregatedBody = group.messages
      .map((m) => m.message_body.trim())
      .filter(Boolean)
      .join("\n");
  }

  // 4. Processar cada grupo
  for (const group of Array.from(groups.values())) {
    try {
      await processGroup(supabase, group);
      processed++;

      // Marcar como completed
      const ids = group.messages.map((m) => m.id);
      await supabase
        .from("message_queue")
        .update({ status: "completed" })
        .in("id", ids);
    } catch (error) {
      console.error(`Erro ao processar grupo ${group.locationId}:${group.contactId}:`, error);
      errors++;

      // Marcar como failed
      const ids = group.messages.map((m) => m.id);
      await supabase
        .from("message_queue")
        .update({ status: "failed" })
        .in("id", ids);
    }
  }

  return { processed, errors };
}

async function processGroup(
  supabase: ReturnType<typeof createAdminClient>,
  group: MessageGroup
): Promise<void> {
  // 1. Buscar agente e config para esta location
  const { data: agent } = await supabase
    .from("agents")
    .select("*, agent_configs(*)")
    .eq("location_id", group.locationId)
    .eq("status", "active")
    .in("type", ["sales_agent", "recruitment_agent"])
    .limit(1)
    .single();

  if (!agent) return;

  const config = Array.isArray(agent.agent_configs)
    ? agent.agent_configs[0]
    : agent.agent_configs;
  if (!config) return;

  // 2. Buscar location para pegar companyId
  const { data: location } = await supabase
    .from("locations")
    .select("*")
    .eq("location_id", group.locationId)
    .single();

  if (!location) return;

  // 3. Buscar historico de conversa do GHL
  const ghlClient = new GHLClient(location.company_id, group.locationId);
  let conversationHistory = "";

  try {
    // Buscar conversa
    const searchResult = await ghlClient.get<{ conversations: { id: string }[] }>(
      "/conversations/search",
      { locationId: group.locationId, contactId: group.contactId }
    );

    if (searchResult.conversations?.[0]?.id) {
      const convId = searchResult.conversations[0].id;

      // Buscar mensagens
      const messagesResult = await ghlClient.get<{ messages: { messages: GHLMessage[] } }>(
        `/conversations/${convId}/messages`,
        { locationId: group.locationId }
      );

      const messages = messagesResult.messages?.messages || [];

      // Formatar historico (limitar a ultimas 30 mensagens para controlar tokens)
      conversationHistory = messages
        .filter((m) => m.messageType === "TYPE_CUSTOM_SMS" || m.body)
        .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime())
        .slice(-30)
        .map((m) => {
          const dir = m.direction === "inbound" ? "LEAD" : "AGENTE";
          const body = (m.body || "[sem conteudo]").substring(0, 500);
          return `${dir}: ${body}`;
        })
        .join("\n");

      // Atualizar conversationId se nao tinhamos
      if (!group.conversationId) {
        group.conversationId = convId;
      }
    }
  } catch (error) {
    console.error("Erro ao buscar historico:", error);
  }

  // 4. Buscar dados do contato no GHL (campos preenchidos)
  const contactData: Record<string, string> = {};
  let contactName = group.contactId;
  try {
    const contactResult = await ghlClient.get<{
      contact: {
        firstName?: string;
        lastName?: string;
        name?: string;
        email?: string;
        phone?: string;
        address1?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
        dateOfBirth?: string;
        companyName?: string;
        customFields?: { id: string; value: string; fieldKey?: string }[];
      };
    }>(`/contacts/${group.contactId}`);

    const c = contactResult.contact;
    if (c) {
      contactName = c.name || c.firstName || group.contactId;

      // Mapear campos padrao
      if (c.firstName) contactData["contact.firstName"] = c.firstName;
      if (c.lastName) contactData["contact.lastName"] = c.lastName;
      if (c.name) contactData["contact.name"] = c.name;
      if (c.email) contactData["contact.email"] = c.email;
      if (c.phone) contactData["contact.phone"] = c.phone;
      if (c.address1) contactData["contact.address1"] = c.address1;
      if (c.city) contactData["contact.city"] = c.city;
      if (c.state) contactData["contact.state"] = c.state;
      if (c.postalCode) contactData["contact.postalCode"] = c.postalCode;
      if (c.country) contactData["contact.country"] = c.country;
      if (c.dateOfBirth) contactData["contact.dateOfBirth"] = c.dateOfBirth;
      if (c.companyName) contactData["contact.companyName"] = c.companyName;

      // Mapear custom fields
      if (c.customFields) {
        for (const cf of c.customFields) {
          if (cf.value) {
            contactData[cf.id] = cf.value;
            if (cf.fieldKey) contactData[cf.fieldKey] = cf.value;
          }
        }
      }
    }
  } catch (error) {
    console.error("Erro ao buscar dados do contato:", error);
  }

  // 5. Mesclar com conversation_state (dados ja coletados pela IA)
  const { data: convState } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("agent_id", agent.id)
    .eq("contact_id", group.contactId)
    .single();

  const previousCollectedData = (convState?.collected_data as Record<string, string>) || {};

  // Dados finais: GHL como base, conversation_state sobrescreve (dados coletados pela IA são mais recentes)
  const collectedData = { ...contactData, ...previousCollectedData };

  // 6. Buscar free slots do calendario (se tem agendamento configurado)
  let availableSlots = "";
  if (config.calendar_id && config.objective !== "qualification_only") {
    try {
      const tz = location.timezone || "America/New_York";
      const now = new Date();

      // GHL espera timestamp em milissegundos (numero)
      const startDate = String(now.getTime());
      const endDate = String(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      console.log(`[FreeSlots] Fetching for calendar ${config.calendar_id}, ${startDate} to ${endDate}`);

      const slotsResult = await ghlClient.get<Record<string, unknown>>(
        `/calendars/${config.calendar_id}/free-slots`,
        { startDate, endDate }
      );

      console.log(`[FreeSlots] Response keys: ${Object.keys(slotsResult).join(", ")}`);

      // Formatar slots para o prompt
      const slotLines: string[] = [];
      for (const [key, value] of Object.entries(slotsResult)) {
        if (key === "traceId" || !value) continue;

        // O GHL pode retornar { "2026-04-08": { slots: ["2026-04-08T14:00:00-04:00", ...] } }
        // ou { "2026-04-08": ["2026-04-08T14:00:00-04:00", ...] }
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
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: tz,
        });

        const slotsFormatted = slots.slice(0, 8).map((s: string) => {
          return new Date(s).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: tz,
          });
        });

        slotLines.push(`${dateFormatted}: ${slotsFormatted.join(", ")}`);
      }

      availableSlots = slotLines.join("\n");
      console.log(`[FreeSlots] Formatted ${slotLines.length} days of slots`);
    } catch (error) {
      console.error("[FreeSlots] Erro ao buscar free slots:", error);
    }
  }

  // 7. Construir prompt (data/hora no timezone da location, NAO em UTC)
  const locationTz = location.timezone || "America/New_York";
  const currentDateInTz = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: locationTz,
  });
  const currentTimeInTz = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: locationTz,
  });

  // Buscar feedback para incluir no prompt
  const { data: feedbackData } = await supabase
    .from("agent_feedback")
    .select("rating, ai_message, suggestion")
    .eq("agent_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(20);

  // Buscar knowledge base
  const { data: kbData } = await supabase
    .from("knowledge_base")
    .select("title, type, content, file_name, file_url")
    .eq("agent_id", agent.id)
    .order("created_at", { ascending: true });

  const knowledgeBase = (kbData || []) as import("@/lib/ai/prompt-builder").KnowledgeBaseItem[];

  const systemPrompt = buildSystemPrompt({
    config,
    contactName,
    collectedData,
    locationName: location.location_name || "Nossa empresa",
    currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
    timezone: locationTz,
    availableSlots,
    feedback: feedbackData as { rating: "positive" | "negative"; ai_message: string; suggestion?: string }[] || [],
    knowledgeBase: knowledgeBase.length > 0 ? knowledgeBase : undefined,
  });

  // 6. Chamar OpenAI
  const aiResult = await processWithAI({
    systemPrompt,
    conversationHistory,
    newMessages: group.aggregatedBody,
    model: config.ai_model || "gpt-4.1-mini",
  });

  if (!aiResult.success || !aiResult.response) {
    throw new Error(aiResult.error || "Falha no processamento AI");
  }

  // 7. Logar uso de tokens
  await supabase.from("execution_log").insert({
    agent_id: agent.id,
    conversation_id: group.conversationId,
    contact_id: group.contactId,
    location_id: group.locationId,
    action_type: "ai_processing",
    action_payload: {
      model: config.ai_model,
      prompt_tokens: aiResult.prompt_tokens,
      completion_tokens: aiResult.completion_tokens,
    },
    ai_model_used: config.ai_model,
    prompt_tokens: aiResult.prompt_tokens,
    completion_tokens: aiResult.completion_tokens,
    duration_ms: aiResult.duration_ms,
    success: true,
  });

  // 7b. Billing — registrar custo e cobrar do wallet
  const { data: locationSettings } = await supabase
    .from("location_settings")
    .select("openai_api_key")
    .eq("location_id", group.locationId)
    .single();

  const usesCustomKey = !!locationSettings?.openai_api_key;

  await trackAndCharge({
    locationId: group.locationId,
    companyId: location.company_id,
    agentId: agent.id,
    contactId: group.contactId,
    actionType: "ai_processing",
    model: config.ai_model || "gpt-4.1-mini",
    promptTokens: aiResult.prompt_tokens || 0,
    completionTokens: aiResult.completion_tokens || 0,
    usesCustomKey,
  });

  // 8. Executar acoes (enviar mensagem, atualizar campos, etc.)
  await executeActions(aiResult.response, {
    companyId: location.company_id,
    locationId: group.locationId,
    contactId: group.contactId,
    agentId: agent.id,
    conversationId: group.conversationId,
    channel: group.channel,
    calendarId: config.calendar_id || undefined,
  });

  // 9. Sincronizar dados coletados pela IA de volta pro GHL
  if (aiResult.response.collected_data && Object.keys(aiResult.response.collected_data).length > 0) {
    await syncCollectedDataToGHL(
      ghlClient,
      group.contactId,
      aiResult.response.collected_data,
      config.data_fields || [],
      supabase,
      { agentId: agent.id, locationId: group.locationId, conversationId: group.conversationId, contactId: group.contactId }
    );
  }

  // 10. Cancelar follow-ups se objetivo foi cumprido
  const finalStatus = aiResult.response.conversation_status;
  const objectiveCompleted = ["qualified", "booked", "disqualified", "handed_off"].includes(finalStatus);

  if (objectiveCompleted) {
    // Cancelar todos follow-ups pendentes
    await supabase
      .from("scheduled_followups")
      .update({ status: "cancelled" })
      .eq("agent_id", agent.id)
      .eq("contact_id", group.contactId)
      .eq("status", "pending");
  }

  // Agendar follow-ups APENAS se conversa ainda ativa e objetivo nao cumprido
  if (
    config.follow_up_config?.enabled &&
    !objectiveCompleted &&
    finalStatus === "active"
  ) {
    await scheduleFollowUps({
      agentId: agent.id,
      locationId: group.locationId,
      contactId: group.contactId,
      conversationId: group.conversationId,
      followUpConfig: config.follow_up_config,
    });
  }

  // 11. Executar automacoes configuradas para este evento
  if (config.automations && Array.isArray(config.automations) && config.automations.length > 0) {
    await executeAutomations(
      ghlClient,
      config.automations,
      finalStatus,
      group.contactId,
      group.locationId,
      supabase,
      agent.id
    );
  }
}

/**
 * Executa automacoes configuradas para um evento especifico.
 */
async function executeAutomations(
  client: GHLClient,
  automations: { event: string; actions: { type: string; tag?: string; pipeline_id?: string; stage_id?: string; field_key?: string; field_value?: string }[] }[],
  currentEvent: string,
  contactId: string,
  locationId: string,
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string
): Promise<void> {
  const matchingRules = automations.filter((a) => a.event === currentEvent);

  for (const rule of matchingRules) {
    for (const action of rule.actions) {
      try {
        switch (action.type) {
          case "add_tag":
            if (action.tag) {
              await client.post(`/contacts/${contactId}/tags`, { tags: [action.tag] });
            }
            break;
          case "remove_tag":
            if (action.tag) {
              await client.delete(`/contacts/${contactId}/tags`, { tags: [action.tag] });
            }
            break;
          case "move_pipeline":
            if (action.pipeline_id && action.stage_id) {
              await client.put("/opportunities/", {
                pipelineId: action.pipeline_id,
                pipelineStageId: action.stage_id,
                contactId,
                locationId,
              });
            }
            break;
          case "update_field":
            if (action.field_key && action.field_value) {
              if (action.field_key.startsWith("contact.")) {
                const fieldName = action.field_key.replace("contact.", "");
                await client.put(`/contacts/${contactId}`, { [fieldName]: action.field_value });
              } else {
                await client.put(`/contacts/${contactId}`, {
                  customFields: [{ id: action.field_key, value: action.field_value }],
                });
              }
            }
            break;
        }

        await supabase.from("execution_log").insert({
          agent_id: agentId,
          contact_id: contactId,
          location_id: locationId,
          action_type: `automation_${action.type}`,
          action_payload: { event: currentEvent, ...action },
          success: true,
        });
      } catch (error) {
        await supabase.from("execution_log").insert({
          agent_id: agentId,
          contact_id: contactId,
          location_id: locationId,
          action_type: `automation_${action.type}`,
          action_payload: { event: currentEvent, ...action },
          success: false,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * Sincroniza dados coletados pela IA de volta pro contato no GHL.
 * So atualiza campos marcados com sync_to_ghl = true na config.
 */
async function syncCollectedDataToGHL(
  client: GHLClient,
  contactId: string,
  collectedData: Record<string, string>,
  dataFields: { key: string; sync_to_ghl?: boolean; ghl_field_id?: string; ghl_field_key?: string }[],
  supabase: ReturnType<typeof createAdminClient>,
  ctx: { agentId: string; locationId: string; conversationId: string; contactId: string }
): Promise<void> {
  // Separar campos padrao de custom fields
  const standardUpdates: Record<string, string> = {};
  const customFieldUpdates: { id: string; value: string }[] = [];

  for (const field of dataFields) {
    if (!field.sync_to_ghl) continue;

    const value = collectedData[field.key];
    if (!value) continue;

    const fieldId = field.ghl_field_id || field.key;

    if (fieldId.startsWith("contact.")) {
      // Campo padrao (contact.firstName, contact.phone, etc.)
      const fieldName = fieldId.replace("contact.", "");
      standardUpdates[fieldName] = value;
    } else {
      // Custom field
      customFieldUpdates.push({ id: fieldId, value });
    }
  }

  // Atualizar campos padrao
  if (Object.keys(standardUpdates).length > 0) {
    try {
      await client.put(`/contacts/${contactId}`, standardUpdates);
      await supabase.from("execution_log").insert({
        agent_id: ctx.agentId,
        location_id: ctx.locationId,
        conversation_id: ctx.conversationId,
        contact_id: ctx.contactId,
        action_type: "sync_standard_fields",
        action_payload: standardUpdates,
        success: true,
      });
    } catch (error) {
      console.error("Erro ao atualizar campos padrao:", error);
      await supabase.from("execution_log").insert({
        agent_id: ctx.agentId,
        location_id: ctx.locationId,
        conversation_id: ctx.conversationId,
        contact_id: ctx.contactId,
        action_type: "sync_standard_fields",
        action_payload: standardUpdates,
        success: false,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Atualizar custom fields
  if (customFieldUpdates.length > 0) {
    try {
      await client.put(`/contacts/${contactId}`, {
        customFields: customFieldUpdates,
      });
      await supabase.from("execution_log").insert({
        agent_id: ctx.agentId,
        location_id: ctx.locationId,
        conversation_id: ctx.conversationId,
        contact_id: ctx.contactId,
        action_type: "sync_custom_fields",
        action_payload: { customFields: customFieldUpdates },
        success: true,
      });
    } catch (error) {
      console.error("Erro ao atualizar custom fields:", error);
      await supabase.from("execution_log").insert({
        agent_id: ctx.agentId,
        location_id: ctx.locationId,
        conversation_id: ctx.conversationId,
        contact_id: ctx.contactId,
        action_type: "sync_custom_fields",
        action_payload: { customFields: customFieldUpdates },
        success: false,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
