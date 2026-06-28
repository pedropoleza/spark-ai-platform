import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "@/lib/ai/sales-prompt-builder";
import { formatAvailableSlots } from "@/lib/ai/slots-format";
import { classifyLastOutbound, extractAiSentTexts } from "@/lib/queue/human-takeover";
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
import { checkContactMatchesTargeting, normalizeTargeting } from "@/lib/queue/targeting";
import type { TargetingRules } from "@/types/agent";
// F27.D (Pedro 2026-05-29): detecção de trigger reativo (msg sintética
// enfileirada pelo reactive-trigger.ts quando tag/stage muda no GHL).
import { isReactiveTriggerBody, parseTriggerBody } from "@/lib/account-assistant/proactive/reactive-trigger";
// F59 (Fix bug observado em prod 2026-06-04): rede de segurança contra
// cold-start quando o fetch de histórico do Spark Leads falha/vem vazio.
import { reconstructHistoryFromDb } from "@/lib/queue/history-fallback";
import { reportError } from "@/lib/admin-signals/report-error";
// F37 (Pedro 2026-05-29): Lead awareness + handoff inteligente.
import { loadLeadHistory, invalidateLeadHistoryCache } from "@/lib/queue/lead-history";
import { evaluateShouldRespond } from "@/lib/queue/should-respond";
import { notifyRepViaSparkbot } from "@/lib/queue/handoff-notify";
import { getLeadHistoryConfig, getHandoffPolicy } from "@/types/agent";
import { notifyCriticalError } from "@/lib/utils/notify";
import { withRetry } from "@/lib/utils/retry";
import type { GHLMessage } from "@/types/ghl";
import type { AutomationRule, TargetingRule } from "@/types/agent";

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
  // F27.D (Pedro 2026-05-29): se a entrada veio do reactive-trigger
  // (CONTACTTAGUPDATE / OPPORTUNITYSTAGEUPDATE), processamos como 1ª msg
  // proativa — sem histórico, sem audio, com instrução clara pro LLM.
  syntheticTrigger?: { kind: string; key: string; pipelineId?: string };
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
    // F27.D: detecção de trigger reativo. Se QUALQUER msg do grupo é sintética,
    // tratamos o grupo todo como trigger (idempotência garante 1 por evento).
    for (const msg of group.messages) {
      const body = msg.message_body.trim();
      if (!body) continue;
      if (isReactiveTriggerBody(body)) {
        const parsed = parseTriggerBody(body);
        if (parsed) {
          group.syntheticTrigger = parsed;
        }
        continue;
      }
      if (body.startsWith("[audio")) {
        parts.push("[O contato enviou um audio]");
      } else if (body === "[media]") {
        parts.push("[O contato enviou um arquivo/imagem]");
      } else {
        parts.push(body);
      }
    }
    if (group.syntheticTrigger) {
      // Substitui aggregatedBody por instrução clara que o LLM lê como "primeira
      // mensagem proativa". O sales-prompt-builder usa isso como user input.
      const t = group.syntheticTrigger;
      const eventDesc =
        t.kind === "tag_added"
          ? `O contato acabou de receber a tag "${t.key}" no Spark Leads`
          : t.kind === "stage_changed"
            ? `O contato acabou de entrar na etapa "${t.key}" do funil${t.pipelineId ? ` (pipeline ${t.pipelineId})` : ""}`
            : `Evento ${t.kind}: ${t.key}`;
      group.aggregatedBody =
        `[GATILHO REATIVO — sem mensagem do contato. ${eventDesc}. ` +
        `Inicie uma conversa proativa coerente com o propósito do agente. ` +
        `Cumprimente, mencione o motivo do contato (sem citar "tag" ou "funil" diretamente — fale natural), ` +
        `e conduza pra próxima etapa do seu objetivo (qualificar/agendar/etc).]`;
    } else {
      group.aggregatedBody = parts.join("\n");
    }
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
    // Observabilidade (Fix bug observado em prod 2026-06-18, caso Marina): esse
    // gate era o ÚNICO skip pré-targeting que NÃO logava — "agente mudo durante
    // pausa" ficava invisível no execution_log (foi o que escondeu a perda do
    // "Florida"). Agora audita. A RECUPERAÇÃO da msg engolida é feita no resume
    // via reenqueueInboundsSincePause (não revertemos pra pending aqui — evita
    // busy-loop de re-claim a cada tick enquanto a conversa segue pausada).
    // try/catch (review 2026-06-18): o insert de auditoria NÃO pode derrubar um
    // SKIP benigno — se lançasse, o grupo viraria 'failed' → reaper re-claima →
    // re-skip → loop de failed só por causa do log. Fail-soft.
    try {
      await supabase.from("execution_log").insert({
        agent_id: agent.id,
        location_id: group.locationId,
        contact_id: group.contactId,
        conversation_id: group.conversationId,
        action_type: "ai_paused_skip",
        action_payload: {
          reason: convState.ai_paused_reason || "manual",
          messages_swallowed: group.messages.length,
        },
        success: true,
      });
    } catch { /* observabilidade best-effort */ }
    return;
  }

  // F28 (Pedro 2026-05-28): max_messages_per_conversation enforcement.
  // Antes: salvo no agent_configs (validation.ts:106) e UI permitia editar
  // (detail-view CatLimits), mas runtime NUNCA contava nem pausava — rep
  // setava "máx 30" e bot ia até 300. Agora:
  //  - message_count é incrementado em action-executor.ts:402 após cada resposta IA.
  //  - Aqui comparamos antes de chamar IA; se ≥ cap, pausa automática.
  //  - Auto-pausa via ai_paused_at evita re-check em cada msg seguinte (próximo
  //    gate de pause filtra).
  const maxMsgs = (config as { max_messages_per_conversation?: number | null })
    .max_messages_per_conversation;
  if (
    typeof maxMsgs === "number" &&
    maxMsgs > 0 &&
    (convState?.message_count ?? 0) >= maxMsgs
  ) {
    const count = convState?.message_count ?? 0;
    log("log", `SKIP max_messages cap atingido (${count}/${maxMsgs})`);
    if (convState && !convState.ai_paused_at) {
      const nowIso = new Date().toISOString();
      await supabase
        .from("conversation_state")
        .update({
          ai_paused_at: nowIso,
          ai_paused_reason: `max_messages_per_conversation:${count}/${maxMsgs}`,
          updated_at: nowIso,
        })
        .eq("agent_id", agent.id)
        .eq("contact_id", group.contactId);
    }
    await supabase.from("execution_log").insert({
      agent_id: agent.id,
      location_id: group.locationId,
      contact_id: group.contactId,
      conversation_id: group.conversationId,
      action_type: "max_messages_skip",
      action_payload: { count, cap: maxMsgs },
      success: true,
    });
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

  // F27 (Pedro 2026-05-28): targeting_rules enforcement.
  // ANTES: regras salvas no wizard/detail-view (tag/custom_field/pipeline_stage)
  // eram IGNORADAS — agente respondia a TODOS os contatos da location.
  // AGORA: se config.targeting_rules tiver regras, contato precisa bater TODAS
  // (AND) pro agente responder. Fail-OPEN em erro de fetch (ver targeting.ts).
  const targetingRules = (config as { targeting_rules?: TargetingRules | null })
    .targeting_rules;
  // GU-6 (Pedro 2026-06-04): ativação manual pela UI (ai_resumed_at) é override
  // explícito do dono da conversa — a IA atende mesmo fora do targeting.
  const manuallyResumed = !!(convState as { ai_resumed_at?: string | null })?.ai_resumed_at;
  // Fix bug observado em prod 2026-06-18 (caso Marina): conversa já ATIVA (a IA
  // já respondeu ≥1× neste segmento) → folhas type="message" do targeting viram
  // NEUTRAS (gatilho de ativação só vale no 1º contato; follow-up "Florida"/"sim"
  // não repete a frase de abertura). Perfil (tag/cf/stage) segue valendo.
  // last_ai_response_at é o sinal primário (robusto ao segment-reset, que zera
  // message_count mas NÃO last_ai_response_at).
  const conversationActive = !!(
    (convState as { last_ai_response_at?: string | null })?.last_ai_response_at ||
    ((convState as { message_count?: number } | null)?.message_count ?? 0) > 0
  );
  // normalizeTargeting cobre array legado E set v2 (Pedro 2026-06-17); null = sem
  // regra efetiva = responde a todos (não chama o gate).
  if (
    !manuallyResumed &&
    normalizeTargeting(targetingRules) &&
    locationForBilling?.company_id
  ) {
    const match = await checkContactMatchesTargeting(
      group.contactId,
      targetingRules,
      locationForBilling.company_id,
      group.locationId,
      // Filtro por mensagem (Pedro 2026-06-17): passa o texto do lead. Em fluxo
      // PROATIVO (syntheticTrigger), o aggregatedBody é instrução nossa → a folha
      // message vira NEUTRA (isProactive). conversationActive → folha message
      // neutra em follow-up (gatilho de ativação só no 1º contato).
      { messageText: group.aggregatedBody, isProactive: !!group.syntheticTrigger, conversationActive },
    );
    if (!match.ok) {
      log("log", `SKIP outside_targeting (${match.reason || "no match"})`);
      // Audit pra dono ver no execution_log que houve skip por targeting.
      await supabase.from("execution_log").insert({
        agent_id: agent.id,
        location_id: group.locationId,
        contact_id: group.contactId,
        conversation_id: group.conversationId,
        action_type: "targeting_skip",
        action_payload: {
          reason: match.reason,
          // v2-aware: array legado → length; set v2 → total de folhas nos grupos.
          rules_count: Array.isArray(targetingRules)
            ? targetingRules.length
            : (normalizeTargeting(targetingRules)?.groups.reduce((n, g) => n + g.rules.length, 0) ?? 0),
        },
        success: true,
      });
      return;
    }
  }

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
    // F59: retry no fetch de histórico (igual aos slots). Antes era single-shot —
    // uma falha transitória do Spark Leads zerava o contexto e a IA cold-startava.
    convId
      ? withRetry(
          () => ghlClient.get<MessagesResp>(`/conversations/${convId}/messages`, { locationId: group.locationId }),
          { maxRetries: 2, baseDelayMs: 200, label: "conv-messages" },
        )
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

  // F52 (Fix bug observado em prod 2026-06-04): fallback de handoff por histórico.
  // O auto_pause_on_human_message "oficial" depende do webhook OutboundMessage do
  // GHL (F51) — que pode não estar assinado. Aqui, ANTES de gastar tokens, a gente
  // olha a última mensagem OUTBOUND da conversa: se NÃO for da IA (humano assumiu),
  // pausa e não responde. Resiliente: pega o handoff no próximo inbound do lead
  // mesmo sem o webhook em tempo real.
  //   - outbound sem texto (áudio/mídia) → humano (a IA só manda texto).
  //   - outbound com texto → anti-eco contra o que a IA registrou ter enviado.
  if (
    (config as { auto_pause_on_human_message?: boolean }).auto_pause_on_human_message === true &&
    !convState?.ai_paused_at &&
    messagesSettled.status === "fulfilled" &&
    messagesSettled.value
  ) {
    const histMsgs = (messagesSettled.value.messages?.messages || [])
      .slice()
      .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime());
    const lastOutbound = [...histMsgs].reverse().find((m) => m.direction === "outbound");
    if (lastOutbound) {
      // Ladder de discriminação F52 (+ fixes Marcela Lana 2026-06-05 / Alves Cury
      // F56 2026-06-10). FONTE ÚNICA em human-takeover.ts: o pill "quem dirige a
      // conversa" (contact-controls) chama a MESMA classifyLastOutbound, então
      // conclui igual a este runtime — sem cópias divergindo. Detalhe de cada
      // discriminador no docstring da função. lastOutbound (GHLMessage) carrega
      // userId/source em runtime mesmo sem o tipo declará-los; a função lê via
      // campos opcionais.
      const { data: aiSends } = await supabase
        .from("execution_log")
        .select("action_payload, created_at")
        .eq("location_id", group.locationId)
        .eq("contact_id", group.contactId)
        .eq("action_type", "send_message")
        .eq("success", true)
        .order("created_at", { ascending: false })
        .limit(30);
      const { isHuman } = classifyLastOutbound({
        lastOutbound,
        aiTexts: extractAiSentTexts(aiSends),
      });
      // Guarda de recência espelhando o webhook F51 (Fix review 2026-06-18): o
      // anti-eco por TEXTO pode falhar se o canal mangleou o corpo OU se o envio
      // da IA não estiver logado. Se a última outbound saiu LOGO APÓS um send
      // nosso (≤120s), é quase certo o eco do próprio envio — NÃO é handoff. Sem
      // isso, o F52 pausava a IA sozinha na cauda de eco perdido (qualquer canal).
      const lastAiSendMs = aiSends?.[0]?.created_at ? new Date(aiSends[0].created_at as string).getTime() : 0;
      const lastOutboundTs = new Date(lastOutbound.dateAdded).getTime();
      const looksLikeOwnEcho =
        lastAiSendMs > 0 && lastOutboundTs - lastAiSendMs <= 120_000 && lastOutboundTs - lastAiSendMs >= -5_000;

      // GU-6 (Pedro 2026-06-04): override "passa a bola pra IA". Se o rep LIGOU
      // o agente manualmente (pill na UI) DEPOIS dessa resposta humana, a IA
      // assume mesmo assim — não re-pausa. Só re-pausa se o humano respondeu
      // MAIS RECENTE que o ai_resumed_at.
      // Race GU-6×F52 (review 2026-06-05): o convState foi lido lá no início
      // (:303), mas áudio/imagem/LLM levam SEGUNDOS. Se o rep clicou "passa a
      // bola pra IA" (GU-6) DURANTE o processamento, o convState em memória tá
      // stale (ai_resumed_at antigo/null) → re-pausaríamos e desfaríamos o
      // resume manual silenciosamente. Re-lê ai_resumed_at FRESCO agora, no
      // último instante antes de decidir. Read único indexado, fail-soft.
      let freshResumedAt: string | null =
        (convState as { ai_resumed_at?: string | null })?.ai_resumed_at ?? null;
      try {
        const { data: freshState } = await supabase
          .from("conversation_state")
          .select("ai_resumed_at")
          .eq("agent_id", agent.id)
          .eq("contact_id", group.contactId)
          .maybeSingle();
        if (freshState) freshResumedAt = (freshState as { ai_resumed_at?: string | null }).ai_resumed_at ?? null;
      } catch {
        /* re-read best-effort: cai pro valor do convState inicial */
      }
      const resumedAtMs = freshResumedAt ? new Date(freshResumedAt).getTime() : 0;
      const lastOutboundMs = new Date(lastOutbound.dateAdded).getTime();
      const overriddenByManualResume = resumedAtMs > 0 && lastOutboundMs <= resumedAtMs;

      if (isHuman && !overriddenByManualResume && !looksLikeOwnEcho) {
        log("log", `F52 handoff: última outbound não é da IA — humano assumiu, pausando contato=${group.contactId}`);
        const nowIso = new Date().toISOString();
        await supabase.from("conversation_state").upsert(
          {
            agent_id: agent.id,
            location_id: group.locationId,
            contact_id: group.contactId,
            conversation_id: group.conversationId || convId || "",
            status: "handed_off",
            ai_paused_at: nowIso,
            ai_paused_reason: "auto_pause:human_message:history",
            updated_at: nowIso,
          },
          { onConflict: "agent_id,contact_id" },
        );
        await supabase.from("execution_log").insert({
          agent_id: agent.id,
          conversation_id: group.conversationId || convId || "",
          contact_id: group.contactId,
          location_id: group.locationId,
          action_type: "ai_paused",
          action_payload: { reason: "auto_pause:human_message:history", trigger: "F52_history_fallback" },
          success: true,
        });
        return; // não responde — humano está conduzindo
      }
    }
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
      // F48 (Pedro 2026-06-04): formatter compartilhado. Antes truncava em
      // slice(0,8) → agente só via manhã/início de tarde e mentia sobre o
      // último horário do dia. Agora mostra o dia inteiro (cap 30/dia) sempre
      // incluindo o último slot real.
      availableSlots = formatAvailableSlots(slotsSettled.value, tz);
      const dayCount = availableSlots ? availableSlots.split("\n").length : 0;
      console.log(`[FreeSlots] Formatted ${dayCount} days`);
      if (dayCount === 0) {
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

  // F37 (Pedro 2026-05-29): Lead awareness + handoff inteligente.
  // Antes de chamar LLM, carrega histórico do Spark Leads (msgs antigas, notas,
  // opp stage, tags) e avalia se bot deve responder OU silenciar+notificar rep.
  // Tudo gated por config — agentes sem flags ON têm comportamento idêntico.
  let leadHistory: import("@/types/agent").LeadContext | undefined;
  const leadHistoryCfg = getLeadHistoryConfig(config as { lead_history_config?: import("@/types/agent").LeadHistoryConfig | null });
  const handoffPol = getHandoffPolicy(config as { handoff_policy?: import("@/types/agent").HandoffPolicy | null });
  // Carrega o histórico do lead se a MEMÓRIA DO LEAD ou o HANDOFF precisarem.
  // Fix review 2026-06-05: antes só carregava com lead_history ON; com handoff ON
  // e lead_history OFF, o gate de handoff (que PRECISA do histórico) nunca
  // disparava — o agente nunca passava a bola pro humano. Pro handoff-only usa um
  // config enxuto (msgs + opps); mas só INJETA no prompt quando a memória do lead
  // está ON de fato (promptCtx.leadHistory abaixo).
  // P1 (review 2026-06-05): invalida o cache do lead-history no início do turno
  // (= a cada novo inbound) — senão o cache de 5min servia histórico STALE pra
  // contatos em conversa ativa (bot perdia o contexto recente). A função
  // invalidateLeadHistoryCache estava exportada mas NUNCA era chamada.
  invalidateLeadHistoryCache(group.contactId);
  const loadHistoryCfg = leadHistoryCfg.enabled
    ? leadHistoryCfg
    : handoffPol.enabled
      ? { ...leadHistoryCfg, enabled: true, include_opportunities: true }
      : null;
  if (loadHistoryCfg && locationForBilling?.company_id) {
    leadHistory = await loadLeadHistory(
      group.contactId,
      locationForBilling.company_id,
      group.locationId,
      loadHistoryCfg,
    );
    if (leadHistoryCfg.enabled) {
      log("log", `lead_history loaded: msgs=${leadHistory.recent_messages.length} notes=${leadHistory.notes.length} opps=${leadHistory.opportunities.length} (${leadHistory.fetch_ms}ms)`);
      await supabase.from("execution_log").insert({
        agent_id: agent.id,
        location_id: group.locationId,
        contact_id: group.contactId,
        conversation_id: group.conversationId,
        action_type: "lead_history_loaded",
        action_payload: {
          messages: leadHistory.recent_messages.length,
          notes: leadHistory.notes.length,
          opportunities: leadHistory.opportunities.length,
          fetch_ms: leadHistory.fetch_ms,
        },
        success: true,
      });
    }
  }

  // Handoff gate: avalia DEPOIS de carregar histórico (precisa contexto).
  if (handoffPol.enabled && leadHistory) {
    const decision = evaluateShouldRespond(leadHistory, group.aggregatedBody, handoffPol);
    if (decision.decision === "skip") {
      log("log", `SKIP por handoff policy: ${decision.reason}`);
      await supabase.from("execution_log").insert({
        agent_id: agent.id,
        location_id: group.locationId,
        contact_id: group.contactId,
        conversation_id: group.conversationId,
        action_type: "should_respond_skip",
        action_payload: { reason: decision.reason, notify_rep: decision.notify_rep },
        success: true,
      });
      // Se policy pede pra avisar rep, dispara handoff notification.
      if (decision.notify_rep) {
        try {
          const result = await notifyRepViaSparkbot({
            agentId: agent.id,
            locationId: group.locationId,
            contactId: group.contactId,
            decision,
            leadContext: leadHistory,
            currentInboundBody: group.aggregatedBody,
          });
          log("log", `handoff notify: notified=${result.notified} rep=${result.rep_id || "—"} skipped=${result.skipped_reason || "—"}`);
        } catch (err) {
          console.warn("[handoff] notify falhou (não-bloqueante):", err instanceof Error ? err.message : err);
        }
      }
      return;
    }
  }

  const promptCtx = {
    config,
    // custom_agent (Plataforma Modular) roda no runtime de lead provado, mas com
    // framing NEUTRO (C2-4 ultra-review 2026-05-26): antes era forçado a
    // "sales_agent" e herdava as REGRAS INVIOLÁVEIS DE VENDAS, que brigavam com o
    // custom_instructions de um agente não-comercial. Agora passa o tipo real e o
    // prompt builder dá um enquadramento que defere ao custom_instructions.
    agentType: (agent.type === "recruitment_agent"
      ? "recruitment_agent"
      : agent.type === "custom_agent"
        ? "custom_agent"
        : "sales_agent") as "sales_agent" | "recruitment_agent" | "custom_agent",
    contactName,
    collectedData,
    locationName: location.location_name || "Nossa empresa",
    currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
    timezone: locationTz,
    availableSlots,
    slotsUnavailable: slotsFetchFailed,
    // Agenda consultada OK porém sem dias livres (cheia/bloqueada) → branch
    // anti-stalling no buildRuntimeContext (Pedro 2026-06-28).
    slotsEmpty: shouldFetchSlots && !slotsFetchFailed && availableSlots.trim() === "",
    feedback: feedbackData as { rating: "positive" | "negative"; ai_message: string; suggestion?: string }[] || [],
    knowledgeBase: knowledgeBase.length > 0 ? knowledgeBase : undefined,
    priorTurnCount: conversationTurns.length,
    // F37: passa lead history pro prompt-builder injetar buildLeadHistorySection.
    // Só injeta se a memória do lead está ON — o handoff pode ter carregado o
    // leadHistory só pro gate, e isso não deve poluir o prompt. Review 2026-06-05.
    leadHistory: leadHistoryCfg.enabled ? leadHistory : undefined,
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

  // F59 (Fix bug observado em prod 2026-06-04): se o histórico do Spark Leads
  // veio VAZIO (fetch falhou mesmo com retry, ou a API retornou 0 msgs) mas essa
  // já é uma conversa CONHECIDA, reconstrói do nosso próprio DB pra IA não
  // cold-startar ("Oi! Sou Assistente... já tenho seus dados aqui"). Roda só aqui,
  // depois dos gates de skip (F52/targeting/should-respond), pra não gastar query
  // nem emitir signal à toa. Se o DB também não tiver nada, é conversa nova mesmo
  // (vazio é correto, sem dano).
  if (conversationTurns.length === 0) {
    const dbTurns = await reconstructHistoryFromDb({
      supabase,
      locationId: group.locationId,
      contactId: group.contactId,
      limit: 30,
    });
    if (dbTurns.length > 0) {
      conversationTurns = dbTurns;
      const ghlFailed = messagesSettled.status === "rejected";
      log("warn", `F59 history fallback: ${dbTurns.length} turns reconstruídos do DB (Spark Leads ${ghlFailed ? "falhou" : "vazio"})`);
      reportError({
        title: "Lead history vazio do Spark Leads — fallback DB",
        feature: "queue-processor",
        severity: "medium",
        description: `O fetch de histórico do Spark Leads veio vazio (${ghlFailed ? "rejeitado após retry" : "0 msgs"}); reconstruí ${dbTurns.length} turns do nosso DB pra evitar cold-start.`,
        metadata: {
          locationId: group.locationId,
          contactId: group.contactId,
          convId,
          ghlFailed,
          reconstructedTurns: dbTurns.length,
        },
      });
    }
  }

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
  let aiResult = await processWithAI({
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

  // F45 (Fix bug observado em prod 2026-06-04): retry-once ANTES de mandar
  // "Desculpa, tive um problema técnico" pro lead.
  // Causa raiz: system_prompt_override de cliente pode instruir o modelo a
  // emitir tokens NÃO-JSON (#Correto, "should_send_message": false "sem JSON")
  // que conflitam com o contrato JSON da plataforma → parseAIResponse falha →
  // lead recebe a genérica. Um único retry com lembrete firme de JSON (anexado
  // à user message pra preservar o cache do system prefix) recupera o slip na
  // quase totalidade dos casos. Se o retry TAMBÉM falhar, segue pra trava de
  // "2 falhas seguidas → pausa" abaixo (lead não recebe genérica em loop).
  if (aiResult.parse_failed) {
    log("warn", "parse_failed — retry 1x com lembrete de JSON antes de cair na genérica");
    const retry = await processWithAI({
      systemPrompt,
      runtimeContext,
      conversationMessages: compressed.turns,
      conversationHistory: "",
      newMessages:
        safeNewMessages +
        '\n\n[SISTEMA: sua resposta anterior não veio no formato JSON exigido. Responda AGORA SOMENTE com o objeto JSON válido especificado, com o campo "message" preenchido com a resposta ao cliente. NÃO use #Correto nem qualquer texto fora do JSON.]',
      model: config.ai_model || "claude-sonnet-4-6",
      images: imageInputs.length > 0 ? imageInputs : undefined,
      responseSchema,
      priorTurnCount: conversationTurns.length,
    });
    if (retry.success && retry.response && !retry.parse_failed) {
      log("log", "retry recuperou JSON válido — lead não recebe a genérica");
      aiResult = retry;
    } else {
      log("error", "retry também falhou no parse — segue pra trava de pausa");
    }
  }

  // Re-narrow pós-retry (o reassign acima alarga o tipo de aiResult.response).
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
      // Sweep F49 2026-06-05: ponto cego real do parse_failed. Reportamos AQUI
      // (lead travou: 2+ JSONs inválidos seguidos → conversa pausada), NÃO em
      // openai-client (que dispararia em toda falha transitória recuperada pelo
      // retry da linha ~1004 = ruído que faz o admin ignorar signals).
      reportError({
        title: "Lead travado: 2+ falhas de parse JSON (conversa pausada)",
        feature: "queue-processor",
        severity: "high",
        description: "A IA retornou JSON inválido 2× seguidas pra este lead; pausei a conversa pra não mandar 'problema técnico' em loop. Lead precisa de atenção humana.",
        metadata: { agentId: agent.id, contactId: group.contactId, locationId: group.locationId },
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
      cacheCreationTokens: aiResult.cache_creation_tokens ?? 0,
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

    // Dedup COMPARTILHADO entre os dois ramos (cada regra dispara 1× por
    // conversa). Lido 1× no início e mergeado num ÚNICO update no fim — evita
    // que um ramo sobrescreva o triggered_automations do outro.
    const alreadyTriggered = new Set<string>(
      Array.isArray(convState?.triggered_automations)
        ? (convState.triggered_automations as string[])
        : []
    );
    const reactionCtx = {
      agentId: agent.id,
      locationId: group.locationId,
      companyId: location.company_id,
      contactId: group.contactId,
      conversationId: group.conversationId,
      channel: group.channel,
    };
    const justExecuted: string[] = [];

    // 11a. Reacoes a dados coletados (on_data_field_set).
    const dataFieldRules = rules.filter((r) => r.trigger?.kind === "on_data_field_set");
    if (dataFieldRules.length > 0) {
      const newCollected = (aiResult.response.collected_data || {}) as Record<string, string>;
      const toFire = pickTriggeredDataFieldRules(
        dataFieldRules,
        previousCollectedData,
        newCollected,
        alreadyTriggered
      );
      if (toFire.length > 0) {
        const { executedRuleIds } = await executeReactionRules(toFire, reactionCtx);
        justExecuted.push(...executedRuleIds);
      }
    }

    // 11b. Automacoes event-based (qualified, booked, etc).
    // C2-2 (ultra-review 2026-05-26): roteado pelo MESMO reaction-engine do ramo
    // de dados — antes ia pro executeAutomations legado, que só tratava 4 das 8
    // acoes (send_text_fixed/send_media/pause_ai/webhook eram descartadas em
    // silencio). Dedup via triggered_automations evita re-disparo a cada turn
    // enquanto o status permanece no evento (essencial p/ send_text/media/webhook
    // nao spammar o lead).
    const eventRules = rules.filter(
      (r) =>
        (!r.trigger || r.trigger.kind === "event") &&
        (r.trigger?.kind === "event" ? r.trigger.event : r.event) === finalStatus &&
        !alreadyTriggered.has(r.id)
    );
    if (eventRules.length > 0) {
      const { executedRuleIds } = await executeReactionRules(eventRules, reactionCtx);
      justExecuted.push(...executedRuleIds);
    }

    // Persiste o dedup uma única vez (merge dos dois ramos).
    if (justExecuted.length > 0) {
      const merged = Array.from(new Set<string>([...alreadyTriggered, ...justExecuted]));
      await supabase
        .from("conversation_state")
        .update({ triggered_automations: merged })
        .eq("agent_id", agent.id)
        .eq("contact_id", group.contactId);
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
