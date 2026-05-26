import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "@/lib/ai/sales-prompt-builder";
import { assembleSystemPrompt, isUnifiedMotorEnabled, templateKeyForAgentType } from "@/lib/agent-platform/assembler";
import { processWithAI } from "@/lib/ai/openai-client";
import type { ImageInput, ConversationTurn } from "@/lib/ai/openai-client";
import { compressHistory } from "@/lib/ai/history-compressor";
import { executeActions } from "@/lib/ai/action-executor";
import { transcribeAudioFromUrl } from "@/lib/ai/audio-transcriber";
import { processMediaAttachments, type ProcessedMedia } from "@/lib/ai/media-processor";
import type { MediaAttachment } from "@/lib/ai/media-extractor";
import { scheduleFollowUps } from "@/lib/queue/follow-up-scheduler";
import { generateSummaryNote } from "@/lib/queue/summary-note-generator";
import { trackAndCharge } from "@/lib/billing/charge";
import { pickTriggeredDataFieldRules, executeReactionRules } from "@/lib/ai/reaction-engine";
import { notifyCriticalError } from "@/lib/utils/notify";
import { withRetry } from "@/lib/utils/retry";
import type { GHLMessage } from "@/types/ghl";
import type { AutomationRule } from "@/types/agent";

interface QueuedMessage {
  id: string;
  agent_id: string | null;
  location_id: string;
  contact_id: string;
  conversation_id: string;
  message_body: string;
  channel?: string;
  audio_url?: string | null;
  audio_mime_type?: string | null;
  media_attachments?: MediaAttachment[] | null;
}

interface MessageGroup {
  agentId: string | null;
  locationId: string;
  contactId: string;
  conversationId: string;
  channel: string;
  messages: QueuedMessage[];
  aggregatedBody: string;
  processedMedia: ProcessedMedia[];
}

/**
 * Processa todas as mensagens prontas na fila.
 *
 * H12 (review 2026-04-28): reaper inline. Antes deste fix, msgs em
 * `status='processing'` ficavam órfãs se o processo morresse (timeout
 * Vercel, SIGKILL, lambda restart) — `finally` não roda em todos cenários.
 * Agora antes de claimar novas, resetamos `processing` > 5min pra pending.
 *
 * H11 (review 2026-04-28): `LIMIT 100` por chamada. O atomic claim em
 * UPDATE...RETURNING garante que mesmo com 60 workers concorrentes (1 por
 * webhook), cada msg é claimada por UM só. Workers que não conseguem
 * claimar nada retornam imediatamente com {processed:0, errors:0}.
 */
export async function processMessageQueue(): Promise<{
  processed: number;
  errors: number;
}> {
  const supabase = createAdminClient();
  let processed = 0;
  let errors = 0;

  // 0. Reaper: reseta msgs órfãs em "processing" > 5 min. Se o processo que
  // claimou morreu, essa janela é o teto de delay antes de a msg voltar pra
  // fila e ser processada de novo. Pode causar processamento duplo se a msg
  // FOI processada mas o lambda morreu antes do UPDATE final — aceitável vs
  // perda total. Idempotência via ghl_message_id UNIQUE evita double-send.
  const reaperCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: orphans } = await supabase
    .from("message_queue")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("updated_at", reaperCutoff)
    .select("id");
  if (orphans && orphans.length > 0) {
    console.warn(`[Processor] Reaped ${orphans.length} orphan 'processing' messages`);
  }

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

  // 3. Agrupar por (agent_id, contact_id) — crucial: sales e recrutamento
  // NAO podem ser agrupados juntos mesmo quando o mesmo contato mandou
  // mensagem para os dois.
  const groups = new Map<string, MessageGroup>();

  for (const msg of pendingMessages) {
    const key = `${msg.agent_id || msg.location_id}:${msg.contact_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        agentId: msg.agent_id || null,
        locationId: msg.location_id,
        contactId: msg.contact_id,
        conversationId: msg.conversation_id,
        channel: msg.channel || "SMS",
        messages: [],
        aggregatedBody: "",
        processedMedia: [],
      });
    }
    groups.get(key)!.messages.push(msg);
  }

  // Agregar bodies (texto puro + placeholders para midia). Audio e imagens
  // sao processados em processGroup onde temos acesso a config/toggles.
  for (const group of Array.from(groups.values())) {
    const parts: string[] = [];
    for (const msg of group.messages) {
      const body = msg.message_body.trim();
      if (!body) continue;
      if (body.startsWith("[audio")) {
        parts.push("[O contato enviou um audio]");
      } else if (body === "[media]") {
        parts.push("[O contato enviou um arquivo/imagem]");
      } else {
        parts.push(body);
      }
    }
    group.aggregatedBody = parts.join("\n");
  }

  // 4. Processar cada grupo
  // H2 (review 2026-04-28): cada grupo é INDEPENDENTE — antes deste fix,
  // o `finally` marcava status do grupo atual baseado em contadores GLOBAIS
  // `errors > processed`, o que dava status errado quando 1 dos N grupos
  // falhava (podia marcar "completed" de grupos que falharam ou "failed" de
  // grupos que passaram). Agora rastreamos sucesso por-grupo.
  for (const group of Array.from(groups.values())) {
    const ids = group.messages.map((m) => m.id);
    let groupSucceeded = false;
    try {
      await processGroup(supabase, group);
      groupSucceeded = true;
      processed++;
    } catch (error) {
      console.error(`[Processor] Erro grupo ${group.contactId}:`, error instanceof Error ? error.message : error);
      errors++;
      notifyCriticalError({
        locationId: group.locationId,
        agentId: group.agentId || undefined,
        contactId: group.contactId,
        errorType: "queue_processing_failure",
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    } finally {
      // SEMPRE marcar mensagens — evita orfãos em "processing"
      await supabase
        .from("message_queue")
        .update({ status: groupSucceeded ? "completed" : "failed" })
        .in("id", ids)
        .eq("status", "processing");
    }
  }

  // Retry: re-enqueue failed messages from last 2 hours (max 10 per cycle)
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: failedMessages } = await supabase
      .from("message_queue")
      .select("id, retry_count, created_at")
      .eq("status", "failed")
      .gte("created_at", twoHoursAgo)
      .lt("retry_count", 3)
      .order("created_at", { ascending: true })
      .limit(10);

    if (failedMessages && failedMessages.length > 0) {
      for (const msg of failedMessages) {
        const retryCount = (msg.retry_count || 0) + 1;
        // Exponential backoff: 1min, 5min, 15min
        const delayMinutes = retryCount === 1 ? 1 : retryCount === 2 ? 5 : 15;
        const processAfter = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

        await supabase
          .from("message_queue")
          .update({
            status: "pending",
            retry_count: retryCount,
            process_after: processAfter,
          })
          .eq("id", msg.id);
      }
      console.log(`[Processor] Retried ${failedMessages.length} failed messages`);
    }
  } catch (retryError) {
    console.error("[Processor] Retry step failed:", retryError instanceof Error ? retryError.message : retryError);
  }

  return { processed, errors };
}

async function processGroup(
  supabase: ReturnType<typeof createAdminClient>,
  group: MessageGroup
): Promise<void> {
  // Request ID único pra correlacionar todos os logs desta execução com o
  // execution_log, facilita debug de "por que o bot não respondeu" etc.
  const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  const log = (level: "log" | "warn" | "error", msg: string) => {
    console[level](`[Processor req=${reqId} contact=${group.contactId.substring(0, 8)}] ${msg}`);
  };
  log("log", `START agent=${group.agentId || "?"} msgs=${group.messages.length}`);

  // 1. Buscar o agente exato gravado na fila. Se agent_id existir,
  // carregamos diretamente por id — sem cair no fallback por location,
  // que misturaria sales com recrutamento. Se nao existir (linha
  // legada pre-migration 00013), usamos fallback por location mas
  // APENAS quando houver 1 agente ativo.
  let agentQuery;
  if (group.agentId) {
    agentQuery = supabase
      .from("agents")
      .select("*, agent_configs(*)")
      .eq("id", group.agentId)
      .eq("status", "active")
      .maybeSingle();
  } else {
    agentQuery = supabase
      .from("agents")
      .select("*, agent_configs(*)")
      .eq("location_id", group.locationId)
      .eq("status", "active")
      .in("type", ["sales_agent", "recruitment_agent", "custom_agent"])
      .limit(1)
      .maybeSingle();
  }
  const { data: agent } = await agentQuery;

  if (!agent) {
    log("log", "SKIP agent not found/inactive");
    return;
  }

  const config = Array.isArray(agent.agent_configs)
    ? agent.agent_configs[0]
    : agent.agent_configs;
  if (!config) {
    log("log", `SKIP no config for agent ${agent.id}`);
    return;
  }

  // Gate de handoff manual + fetch full convState for later use (conversationId cache, collected_data)
  const { data: convState } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("agent_id", agent.id)
    .eq("contact_id", group.contactId)
    .maybeSingle();

  if (convState?.ai_paused_at) {
    log("log", `SKIP IA pausada (${convState.ai_paused_reason || "manual"})`);
    return;
  }

  // 1b. Processar audio e midia conforme toggles habilitados
  const enableAudio = config.enable_audio_transcription === true;
  const enableImage = config.enable_image_analysis === true;
  const enablePdf = config.enable_pdf_reading === true;

  // Pra cobrar Whisper precisamos de company_id antecipadamente.
  // Buscamos location aqui ao invés de no §2 — evita refactor maior do
  // pipeline. (Mantida cópia abaixo no §2 pra retrocompat dos refs `location`
  // a partir dali.)
  const { data: locationForBilling } = await supabase
    .from("locations")
    .select("company_id, location_id")
    .eq("location_id", group.locationId)
    .single();

  // Custom key check (BYO key skipa cobrança)
  let usesCustomKeyForAudio = false;
  if (locationForBilling) {
    try {
      const { data: ls } = await supabase
        .from("location_settings")
        .select("openai_api_key")
        .eq("location_id", group.locationId)
        .maybeSingle();
      usesCustomKeyForAudio = !!ls?.openai_api_key;
    } catch {
      // location_settings ausente — assume sem BYO key
    }
  }

  // Audio: transcrever se toggle ativo
  if (enableAudio) {
    for (const msg of group.messages) {
      let audioUrl = msg.audio_url || null;
      const audioMime = msg.audio_mime_type || undefined;
      if (!audioUrl && msg.message_body.startsWith("[audio: ")) {
        const match = msg.message_body.match(/\[audio:\s*(https?:\/\/[^\]]+)\]/);
        if (match) audioUrl = match[1];
      }
      if (audioUrl) {
        console.log(`[Processor] Transcribing audio (toggle ON): ${audioUrl.substring(0, 80)}`);
        const result = await transcribeAudioFromUrl(audioUrl, audioMime);
        if (result?.text) {
          group.aggregatedBody = [group.aggregatedBody, result.text].filter(Boolean).join("\n");

          // C3: cobrar Whisper. Antes deste fix, áudio rodava 100% free.
          if (locationForBilling && result.audio_seconds > 0) {
            try {
              await trackAndCharge({
                locationId: group.locationId,
                companyId: locationForBilling.company_id,
                agentId: agent.id,
                contactId: group.contactId,
                actionType: "audio_transcription",
                model: result.model,
                audioSeconds: result.audio_seconds,
                audioModel: result.model,
                usesCustomKey: usesCustomKeyForAudio,
              });
            } catch (e) {
              console.error("[Processor] Whisper billing failed (non-blocking):", e instanceof Error ? e.message : e);
            }
          }
        }
      }
    }
  }

  // Midia: processar imagens e docs conforme toggles
  if (enableImage || enablePdf) {
    const allMediaAttachments: MediaAttachment[] = [];
    for (const msg of group.messages) {
      const atts = msg.media_attachments;
      if (Array.isArray(atts) && atts.length > 0) {
        // Filtrar apenas tipos habilitados
        for (const att of atts) {
          const mime = att.contentType.toLowerCase();
          if (mime.startsWith("image/") && enableImage) allMediaAttachments.push(att);
          else if (!mime.startsWith("image/") && enablePdf) allMediaAttachments.push(att);
        }
      }
    }
    if (allMediaAttachments.length > 0) {
      console.log(`[Processor] Processing ${allMediaAttachments.length} media (image=${enableImage}, pdf=${enablePdf})`);
      const processed = await processMediaAttachments(allMediaAttachments);
      group.processedMedia = processed;
      for (const media of processed) {
        if (media.type === "document" && media.extractedText) {
          group.aggregatedBody = [group.aggregatedBody, `[Documento "${media.fileName || "anexo"}"]: ${media.extractedText}`].filter(Boolean).join("\n");
        } else if (media.error) {
          group.aggregatedBody = [group.aggregatedBody, `[${media.type === "image" ? "Imagem" : "Arquivo"}: ${media.error}]`].filter(Boolean).join("\n");
        }
      }
    }
  }

  // 2. Buscar location para pegar companyId
  const { data: location } = await supabase
    .from("locations")
    .select("*")
    .eq("location_id", group.locationId)
    .single();

  if (!location) return;

  // 3. Buscar dados do GHL em paralelo (messages + contact + slots).
  // Pre-step: garantir convId (sequencial, mas só executa se não tiver cache).
  const ghlClient = new GHLClient(location.company_id, group.locationId);
  let convId = convState?.conversation_id || group.conversationId || "";
  if (!convId) {
    try {
      const searchResult = await ghlClient.get<{ conversations: { id: string }[] }>(
        "/conversations/search",
        { locationId: group.locationId, contactId: group.contactId }
      );
      convId = searchResult.conversations?.[0]?.id || "";
    } catch (error) {
      console.error("Erro buscando convId:", error);
    }
  }

  const shouldFetchSlots = !!config.calendar_id && config.objective !== "qualification_only";
  const slotsNow = new Date();
  const slotsStartDate = String(slotsNow.getTime());
  const slotsEndDate = String(slotsNow.getTime() + 7 * 24 * 60 * 60 * 1000);

  type MessagesResp = { messages: { messages: GHLMessage[] } };
  type ContactResp = { contact: {
    firstName?: string; lastName?: string; name?: string; email?: string; phone?: string;
    address1?: string; city?: string; state?: string; postalCode?: string; country?: string;
    dateOfBirth?: string; companyName?: string;
    customFields?: { id: string; value: string; fieldKey?: string }[];
  } };
  type SlotsResp = Record<string, unknown>;

  const ghlStart = Date.now();
  const [messagesSettled, contactSettled, slotsSettled] = await Promise.allSettled([
    convId
      ? ghlClient.get<MessagesResp>(`/conversations/${convId}/messages`, { locationId: group.locationId })
      : Promise.resolve<MessagesResp | null>(null),
    ghlClient.get<ContactResp>(`/contacts/${group.contactId}`),
    shouldFetchSlots
      ? withRetry(
          () => ghlClient.get<SlotsResp>(
            `/calendars/${config.calendar_id}/free-slots`,
            { startDate: slotsStartDate, endDate: slotsEndDate },
          ),
          { maxRetries: 2, baseDelayMs: 200, label: "free-slots" },
        )
      : Promise.resolve<SlotsResp | null>(null),
  ]);
  console.log(`[GHL] parallel fetch done in ${Date.now() - ghlStart}ms`);

  // Processar mensagens como turns estruturados (formato nativo do LLM).
  // Ganhos: modelo entende turn boundaries, menos tokens (sem "LEAD:/AGENTE:"),
  // e cache hit melhor — cada turn anterior é byte-exact estável.
  let conversationTurns: ConversationTurn[] = [];
  if (messagesSettled.status === "fulfilled" && messagesSettled.value) {
    const messages = messagesSettled.value.messages?.messages || [];
    conversationTurns = messages
      .filter((m) => m.messageType === "TYPE_CUSTOM_SMS" || m.body)
      .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime())
      .slice(-30)
      .map((m) => ({
        role: m.direction === "inbound" ? "user" : "assistant" as const,
        content: (m.body || "[sem conteudo]").substring(0, 500),
      }));

    if (!group.conversationId) group.conversationId = convId;
    if (convId && convState && !convState.conversation_id) {
      await supabase.from("conversation_state")
        .update({ conversation_id: convId })
        .eq("agent_id", agent.id)
        .eq("contact_id", group.contactId);
    }
  } else if (messagesSettled.status === "rejected") {
    console.error("Erro ao buscar historico:", messagesSettled.reason);
  }

  // Processar contato
  const contactData: Record<string, string> = {};
  let contactName = group.contactId;
  if (contactSettled.status === "fulfilled" && contactSettled.value?.contact) {
    const c = contactSettled.value.contact;
    contactName = c.name || c.firstName || group.contactId;
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
    if (c.customFields) {
      for (const cf of c.customFields) {
        if (cf.value) {
          contactData[cf.id] = cf.value;
          if (cf.fieldKey) contactData[cf.fieldKey] = cf.value;
        }
      }
    }
  } else if (contactSettled.status === "rejected") {
    console.error("Erro ao buscar dados do contato:", contactSettled.reason);
  }

  // 4. Mesclar com conversation_state (dados coletados pela IA têm prioridade)
  const previousCollectedData = (convState?.collected_data as Record<string, string>) || {};
  const collectedData = { ...contactData, ...previousCollectedData };

  // 5. Processar slots (e detectar fail irrecuperável para guardrail)
  let availableSlots = "";
  let slotsFetchFailed = false;
  if (shouldFetchSlots) {
    if (slotsSettled.status === "fulfilled" && slotsSettled.value) {
      const tz = location.timezone || "America/New_York";
      const slotLines: string[] = [];
      for (const [key, value] of Object.entries(slotsSettled.value)) {
        if (key === "traceId" || !value) continue;
        let slots: string[] = [];
        if (typeof value === "object" && value !== null) {
          const v = value as Record<string, unknown>;
          if (Array.isArray(v.slots)) slots = v.slots as string[];
          else if (Array.isArray(value)) slots = value as string[];
        }
        if (slots.length === 0) continue;

        const dateFormatted = new Date(key + "T12:00:00").toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric", timeZone: tz,
        });
        const slotsFormatted = slots.slice(0, 8).map((s: string) =>
          new Date(s).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
          })
        );
        slotLines.push(`${dateFormatted}: ${slotsFormatted.join(", ")}`);
      }
      availableSlots = slotLines.join("\n");
      console.log(`[FreeSlots] Formatted ${slotLines.length} days`);
      if (slotLines.length === 0) {
        console.warn(`[FreeSlots] No slots found — calendar may be full or misconfigured`);
      }
    } else {
      slotsFetchFailed = true;
      console.error(
        `[FreeSlots] All retries failed:`,
        slotsSettled.status === "rejected"
          ? (slotsSettled.reason instanceof Error ? slotsSettled.reason.message : slotsSettled.reason)
          : "unknown",
      );
    }
  } else {
    console.log(`[FreeSlots] Skipped: calendar_id=${config.calendar_id || "NONE"} objective=${config.objective}`);
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

  // Buscar feedback + knowledge base em paralelo (queries independentes)
  const [{ data: feedbackData }, { data: kbData }] = await Promise.all([
    supabase
      .from("agent_feedback")
      .select("rating, ai_message, suggestion")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("knowledge_base")
      .select("title, type, content, file_name, file_url, description, usage_instructions")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: true }),
  ]);

  const knowledgeBase = (kbData || []) as import("@/lib/ai/sales-prompt-builder").KnowledgeBaseItem[];

  // KB parte B: templates via carrier RAG. Se o agente tem enabled_kbs (NLG/
  // Brazillionaires), recupera chunks relevantes da carrier_knowledge pela
  // mensagem do lead e injeta como conhecimento. Gated + fail-safe (erro =
  // segue sem). Mesma infra do SparkBot (search_carrier_knowledge).
  const enabledKbs = Array.isArray((config as { enabled_kbs?: unknown }).enabled_kbs)
    ? ((config as { enabled_kbs?: string[] }).enabled_kbs as string[])
    : [];
  if (enabledKbs.length > 0 && group.aggregatedBody && group.aggregatedBody.trim().length >= 3) {
    try {
      const { retrieveCarrierKnowledge, carrierLabel } = await import("@/lib/knowledge/carrier-retrieval");
      const chunks = await retrieveCarrierKnowledge(enabledKbs, group.aggregatedBody, 3);
      for (const c of chunks) {
        knowledgeBase.push({ title: `[${carrierLabel(c.carrier)}] ${c.title}`, type: "text", content: c.content });
      }
      if (chunks.length > 0) {
        console.log(`[Queue] carrier RAG: +${chunks.length} chunks (${enabledKbs.join(",")}) agent=${agent.id}`);
      }
    } catch (err) {
      console.warn("[Queue] carrier RAG falhou (segue sem):", err instanceof Error ? err.message : err);
    }
  }

  const promptCtx = {
    config,
    // custom_agent (Plataforma Modular) roda no runtime de lead provado (caminho
    // sales); o comportamento vem do custom_instructions. Motor modular dedicado
    // pro custom entra depois, validado. Recrutamento mantém o seu; o resto = sales.
    agentType: (agent.type === "recruitment_agent" ? "recruitment_agent" : "sales_agent") as "sales_agent" | "recruitment_agent",
    contactName,
    collectedData,
    locationName: location.location_name || "Nossa empresa",
    currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
    timezone: locationTz,
    availableSlots,
    slotsUnavailable: slotsFetchFailed,
    feedback: feedbackData as { rating: "positive" | "negative"; ai_message: string; suggestion?: string }[] || [],
    knowledgeBase: knowledgeBase.length > 0 ? knowledgeBase : undefined,
    priorTurnCount: conversationTurns.length,
  };
  // Plataforma Modular (Fase 2): roteia a montagem do prompt pelo motor unificado
  // quando AGENT_MOTOR_UNIFIED tá ON. Como o assembler delega pro mesmo
  // buildSystemPrompt, o output é idêntico (paridade — test-sales-parity.ts).
  // Flag OFF (default) = caminho legado, byte-a-byte igual.
  const systemPrompt = isUnifiedMotorEnabled()
    ? assembleSystemPrompt({
        templateKey: templateKeyForAgentType(agent.type),
        audience: "lead",
        leadArgs: promptCtx,
      })
    : buildSystemPrompt(promptCtx);
  const runtimeContext = buildRuntimeContext(promptCtx);
  const responseSchema = buildResponseJsonSchema(promptCtx);

  // 6. Chamar OpenAI (com imagens se houver)
  const imageInputs: ImageInput[] = group.processedMedia
    .filter((m) => m.type === "image" && !m.error)
    .map((m) => ({ url: m.url, base64DataUri: m.base64DataUri }));

  // Rolling summarization: se histórico passou de threshold, condensar
  // mensagens antigas num resumo reaproveitável (cacheado em conversation_state).
  const compressed = await compressHistory({
    turns: conversationTurns,
    cachedSummary: (convState as { history_summary?: string } | null)?.history_summary,
    cachedCoveredCount: (convState as { history_summary_covers_count?: number } | null)?.history_summary_covers_count,
    billing: {
      locationId: group.locationId,
      companyId: location.company_id,
      agentId: agent.id,
      contactId: group.contactId,
      usesCustomKey: usesCustomKeyForAudio,
    },
  });
  if (compressed.regenerated && compressed.summary) {
    // Persistir summary atualizado. Fire-and-forget para não atrasar a resposta.
    void supabase
      .from("conversation_state")
      .update({
        history_summary: compressed.summary,
        history_summary_covers_count: compressed.coveredCount,
      })
      .eq("agent_id", agent.id)
      .eq("contact_id", group.contactId);
  }

  // Fix CRIT-2 (deep review 2026-05-05): se aggregatedBody=="" (lead mandou
  // só mídia que falhou no parse, ex: PDF com pdf_reading=false), Claude
  // rejeita 400 "text content blocks must be non-empty". Fallback string
  // descritiva pro LLM saber que houve algo enviado.
  const safeNewMessages = group.aggregatedBody && group.aggregatedBody.trim()
    ? group.aggregatedBody
    : "[contato enviou conteúdo não processável (mídia ou anexo)]";

  // Fix MED-7: detectar Claude por prefix em vez de hardcoded version list.
  // Antes: hardcoded ["claude-sonnet-4-6", "claude-haiku-4-5", ...] —
  // quando admin selecionava claude-sonnet-4-7 (ou versão futura), caía em
  // OpenAI client + erro modelo desconhecido. Default Sonnet.
  const aiResult = await processWithAI({
    systemPrompt,
    runtimeContext,
    conversationMessages: compressed.turns,
    conversationHistory: "",
    newMessages: safeNewMessages,
    model: config.ai_model || "claude-sonnet-4-6",
    images: imageInputs.length > 0 ? imageInputs : undefined,
    responseSchema,
    priorTurnCount: conversationTurns.length,
  });

  if (!aiResult.success || !aiResult.response) {
    throw new Error(aiResult.error || "Falha no processamento AI");
  }

  // 6b. Detectar loop de parse failure: se a IA retornou JSON inválido duas
  // vezes seguidas nesta conversa, pausa e alerta em vez de ficar mandando
  // "desculpa, tive um problema técnico" repetidamente.
  if (aiResult.parse_failed) {
    const { data: recentFailures } = await supabase
      .from("execution_log")
      .select("id, action_payload")
      .eq("agent_id", agent.id)
      .eq("contact_id", group.contactId)
      .eq("action_type", "ai_processing")
      .order("created_at", { ascending: false })
      .limit(1);

    const lastWasFailure = recentFailures?.[0]?.action_payload &&
      (recentFailures[0].action_payload as { parse_failed?: boolean }).parse_failed === true;

    if (lastWasFailure) {
      log("error", "PAUSE 2+ parse failures — pausing conversation");
      const nowIso = new Date().toISOString();
      await supabase
        .from("conversation_state")
        .upsert(
          {
            agent_id: agent.id,
            location_id: group.locationId,
            contact_id: group.contactId,
            conversation_id: group.conversationId,
            status: convState?.status || "active",
            ai_paused_at: nowIso,
            ai_paused_reason: "ai_parse_failure_loop",
            updated_at: nowIso,
          },
          { onConflict: "agent_id,contact_id" }
        );
      await supabase.from("execution_log").insert({
        agent_id: agent.id,
        conversation_id: group.conversationId,
        contact_id: group.contactId,
        location_id: group.locationId,
        action_type: "ai_paused",
        action_payload: { reason: "ai_parse_failure_loop" },
        success: true,
      });
      return; // Não envia resposta genérica, não executa ações
    }
  }

  // 7. Logar uso de tokens
  await supabase.from("execution_log").insert({
    agent_id: agent.id,
    conversation_id: group.conversationId,
    contact_id: group.contactId,
    location_id: group.locationId,
    action_type: "ai_processing",
    action_payload: {
      request_id: reqId,
      model: config.ai_model,
      prompt_tokens: aiResult.prompt_tokens,
      completion_tokens: aiResult.completion_tokens,
      cached_tokens: aiResult.cached_tokens,
      cache_hit_ratio: aiResult.cache_hit_ratio,
      parse_failed: aiResult.parse_failed || false,
    },
    ai_model_used: config.ai_model,
    prompt_tokens: aiResult.prompt_tokens,
    completion_tokens: aiResult.completion_tokens,
    duration_ms: aiResult.duration_ms,
    success: true,
  });

  // 7b. Billing — registrar custo e cobrar do wallet
  let usesCustomKey = false;
  try {
    const { data: locationSettings } = await supabase
      .from("location_settings")
      .select("openai_api_key")
      .eq("location_id", group.locationId)
      .maybeSingle();
    usesCustomKey = !!locationSettings?.openai_api_key;
  } catch {
    // location_settings pode nao existir — prosseguir sem custom key
  }

  try {
    // Fix HIGH-2 (deep review 2026-05-05): incluir imageCount no billing.
    // Antes, vision em gpt-4o (~$0.0085/img high detail) NÃO era cobrado
    // em sales/recruitment — só Sparkbot. Agora paridade.
    await trackAndCharge({
      locationId: group.locationId,
      companyId: location.company_id,
      agentId: agent.id,
      contactId: group.contactId,
      actionType: "ai_processing",
      model: config.ai_model || "claude-sonnet-4-6",
      promptTokens: aiResult.prompt_tokens || 0,
      completionTokens: aiResult.completion_tokens || 0,
      cachedTokens: aiResult.cached_tokens || 0,
      imageCount: imageInputs.length,
      usesCustomKey,
    });
  } catch (billingError) {
    console.error("[Processor] Billing failed (non-blocking):", billingError instanceof Error ? billingError.message : billingError);
  }

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
  console.log(`[Processor] Final status: ${finalStatus} | objectiveCompleted: ${objectiveCompleted} | contact: ${group.contactId}`);

  if (objectiveCompleted) {
    // Cancelar todos follow-ups pendentes
    await supabase
      .from("scheduled_followups")
      .update({ status: "cancelled" })
      .eq("agent_id", agent.id)
      .eq("contact_id", group.contactId)
      .eq("status", "pending");

    // Gerar nota de resumo no GHL
    try {
      console.log(`[Processor] Generating summary note for ${group.contactId} (trigger: ${finalStatus})`);
      await generateSummaryNote({
        agentId: agent.id,
        locationId: group.locationId,
        contactId: group.contactId,
        conversationId: group.conversationId,
        companyId: location.company_id,
        triggerReason: finalStatus,
        aiModel: config.ai_model || "gpt-4.1-mini",
      });
    } catch (noteErr) {
      console.error("[Processor] Summary note error:", noteErr instanceof Error ? noteErr.message : noteErr);
    }
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

  // 11a. Reacoes a dados coletados (on_data_field_set).
  // Aplicado imediatamente apos executeActions, que ja atualizou
  // conversation_state com o novo collected_data.
  if (config.automations && Array.isArray(config.automations) && config.automations.length > 0) {
    const rules = config.automations as AutomationRule[];
    const dataFieldRules = rules.filter((r) => r.trigger?.kind === "on_data_field_set");

    if (dataFieldRules.length > 0) {
      const newCollected = (aiResult.response.collected_data || {}) as Record<string, string>;
      const alreadyTriggered = new Set<string>(
        Array.isArray(convState?.triggered_automations)
          ? (convState.triggered_automations as string[])
          : []
      );

      const toFire = pickTriggeredDataFieldRules(
        dataFieldRules,
        previousCollectedData,
        newCollected,
        alreadyTriggered
      );

      if (toFire.length > 0) {
        const { executedRuleIds } = await executeReactionRules(toFire, {
          agentId: agent.id,
          locationId: group.locationId,
          companyId: location.company_id,
          contactId: group.contactId,
          conversationId: group.conversationId,
          channel: group.channel,
        });

        if (executedRuleIds.length > 0) {
          const mergedSet = new Set<string>();
          alreadyTriggered.forEach((v) => mergedSet.add(v));
          executedRuleIds.forEach((v) => mergedSet.add(v));
          const merged: string[] = [];
          mergedSet.forEach((v) => merged.push(v));
          await supabase
            .from("conversation_state")
            .update({ triggered_automations: merged })
            .eq("agent_id", agent.id)
            .eq("contact_id", group.contactId);
        }
      }
    }

    // 11b. Automacoes event-based legadas (qualified, booked, etc)
    const eventRules = rules.filter(
      (r) => !r.trigger || r.trigger.kind === "event"
    );
    if (eventRules.length > 0) {
      await executeAutomations(
        ghlClient,
        eventRules,
        finalStatus,
        group.contactId,
        group.locationId,
        supabase,
        agent.id
      );
    }
  }
}

/**
 * Executa automacoes event-based para um evento especifico.
 * Aceita tanto o shape legado (`event: "qualified"`) quanto o novo
 * (`trigger: { kind: "event", event: "qualified" }`).
 */
async function executeAutomations(
  client: GHLClient,
  automations: AutomationRule[],
  currentEvent: string,
  contactId: string,
  locationId: string,
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string
): Promise<void> {
  const matchingRules = automations.filter((a) => {
    if (a.trigger?.kind === "event") return a.trigger.event === currentEvent;
    return a.event === currentEvent;
  });

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
