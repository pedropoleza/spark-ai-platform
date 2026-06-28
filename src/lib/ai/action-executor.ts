import { GHLClient } from "@/lib/ghl/client";
import { channelToMessageType } from "@/lib/ghl/channel";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMeetingLocation } from "@/lib/queue/meeting-links";
import {
  addTagsToContact,
  removeTagsFromContact,
  updateContactField,
  isBookingConflictError,
  findContactOpportunityId,
  updateOpportunity,
} from "@/lib/ghl/operations";
import { reportError } from "@/lib/admin-signals/report-error";
import type { AIAction, AIResponse } from "@/types/ai";

// Delay curto entre mensagens (max 1.5s para não causar timeout no serverless)
function shortDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));
}

function normalizeMessages(message: string | string[]): string[] {
  if (Array.isArray(message)) {
    return message.filter((m) => typeof m === "string" && m.trim());
  }
  if (typeof message === "string" && message.trim()) {
    return [message];
  }
  return [];
}

interface ExecutionContext {
  companyId: string;
  locationId: string;
  contactId: string;
  agentId: string;
  conversationId: string;
  channel?: string;
  calendarId?: string;         // Calendar ID do config (overrides o que a IA manda)
  skipSendMessage?: boolean;
  testMode?: boolean;
}

// Mapeia canal para o "type" da API de mensagens do GHL
export async function executeActions(
  response: AIResponse,
  ctx: ExecutionContext
): Promise<void> {
  const client = new GHLClient(ctx.companyId, ctx.locationId);
  const supabase = createAdminClient();

  const messageType = channelToMessageType(ctx.channel);

  // 1. Executar acoes PRIMEIRO (book, reschedule, update fields, tags)
  // Fix HIGH-10 (deep review 2026-05-05): dedup actions por
  // (type, calendar_id?, start_time?, appointment_id?, field_key?, tag?,
  // pipeline_id?, stage_id?). Antes, LLM podia retornar mesma action 2x
  // (book_appointment com mesmo start_time) → race em findExistingAppointment
  // criava 2 appointments OU update incorreto.
  const dedupKey = (a: typeof response.actions[number]): string => {
    return JSON.stringify({
      t: a.type,
      f: a.field_key || "",
      v: a.value || "",
      tag: a.tag || "",
      cal: a.calendar_id || "",
      st: a.start_time || "",
      apt: a.appointment_id || "",
      pip: a.pipeline_id || "",
      stg: a.stage_id || "",
    });
  };
  const seen = new Set<string>();
  const dedupedActions = response.actions.filter((a) => {
    const k = dedupKey(a);
    if (seen.has(k)) {
      console.warn("[ActionExecutor] Skipping duplicate action:", a.type);
      return false;
    }
    seen.add(k);
    return true;
  });

  let actionsFailed = false;
  let failedActionError = "";

  for (const action of dedupedActions) {
    try {
      await executeAction(client, action, ctx);
      await logExecution(supabase, ctx, action.type, { ...action });
    } catch (error) {
      actionsFailed = true;
      failedActionError = error instanceof Error ? error.message : String(error);
      await logExecution(supabase, ctx, action.type, { ...action }, false, error);
    }
  }

  // 2. Enviar mensagem(ns) pelo mesmo canal (pula no modo teste)
  let messages = normalizeMessages(response.message);

  // Garantia: se mensagem vazia, usar continuacao neutra (nao um cumprimento)
  if (messages.length === 0) {
    console.warn("[ActionExecutor] Empty message, using neutral continuation");
    messages = ["Pode me contar mais sobre isso?"];
  }

  if (!ctx.skipSendMessage && messages.length > 0) {
    try {
      // Se agendamento falhou, avisar o lead. Detection centralizada em lib/ghl/operations.ts.
      const isBookingError = actionsFailed && isBookingConflictError(failedActionError);
      if (isBookingError) {
        const errorMsg = "Desculpa, nao consegui agendar nesse horario. Posso sugerir outro?";
        await client.post("/conversations/messages", {
          type: messageType,
          contactId: ctx.contactId,
          message: errorMsg,
        });
        await logExecution(supabase, ctx, "send_error_message", { message: errorMsg });
      } else {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg.trim()) continue;

          if (i > 0) {
            await shortDelay();
          }

          await client.post("/conversations/messages", {
            type: messageType,
            contactId: ctx.contactId,
            message: msg,
          });
        }

        await logExecution(supabase, ctx, "send_message", {
          message: messages,
          parts: messages.length,
          channel: ctx.channel || "SMS",
        });
      }
    } catch (error) {
      await logExecution(supabase, ctx, "send_message", { message: response.message }, false, error);
      // Sweep ultra-review 2026-06-15: este era o ÚNICO send-path lead-facing mudo no
      // catch (só logExecution, sem alerta). GHL/Stevo caindo = lead sem resposta e
      // ZERO sinal pro admin (ponto cego do F49). reportError → admin_signal high +
      // Sentry. NÃO re-lança de propósito: preserva o fluxo atual (grupo conclui, sem
      // retry/double-send) — mudar pra retry exige eval supervisionado.
      reportError({
        title: "Agente lead-facing: falha ao enviar mensagem",
        feature: "action-executor-send",
        error,
        severity: "high",
        description:
          "client.post(/conversations/messages) falhou no envio pro lead (sales/recruitment). Lead pode não ter recebido a resposta.",
        metadata: {
          location_id: ctx.locationId,
          contact_id: ctx.contactId,
          agent_id: ctx.agentId,
          channel: ctx.channel || "SMS",
        },
      });
    }
  }

  // 3. Atualizar conversation_state — SKIP em test mode pra não poluir
  // estado real da conversa do contato.
  // Fix CRIT-1 (deep review 2026-05-05): antes, testar agente em /test
  // com execActions=true E contact_id real corrompia conversation_state
  // de prod (last_ai_response_at, message_count, status, conversation_id).
  // Resultado: bot real ficava com follow-ups cancelados, summary gerado
  // antecipadamente, contagem inflada. Agora testMode preserva estado real.
  if (!ctx.testMode) {
    await updateConversationState(supabase, ctx, response);
  }
}

async function executeAction(
  client: GHLClient,
  action: AIAction,
  ctx: ExecutionContext
): Promise<void> {
  if (ctx.testMode) {
    console.log(`[TEST] Would execute: ${action.type}`, JSON.stringify(action).substring(0, 200));
    return;
  }

  switch (action.type) {
    case "update_field":
      if (action.field_key && action.value) {
        // Sales/recruitment legado prefixa standard fields com "contact." —
        // ex: "contact.firstName". updateContactField espera só o key, sem prefix.
        const key = action.field_key.startsWith("contact.")
          ? action.field_key.slice("contact.".length)
          : action.field_key;
        await updateContactField(client, ctx.contactId, key, action.value);
      }
      break;

    case "add_tag":
      if (action.tag) {
        await addTagsToContact(client, ctx.contactId, [action.tag]);
      }
      break;

    case "remove_tag":
      if (action.tag) {
        await removeTagsFromContact(client, ctx.contactId, [action.tag]);
      }
      break;

    case "book_appointment": {
      const bookCalendarId = ctx.calendarId || action.calendar_id;
      if (!bookCalendarId) {
        throw new Error("Calendario nao configurado — agendamento impossivel");
      }
      // Link da reunião por calendário (caso Marina 2026-06-28): quando o calendário
      // tem link configurado, injeta address+override; senão null = mantém o default
      // histórico ("phone"), sem afetar outros agentes lead-facing.
      const meetingLoc = resolveMeetingLocation(bookCalendarId);
      if (bookCalendarId && action.start_time) {
        const existingApptForBook = await findExistingAppointment(client, ctx.contactId, ctx.locationId);

        if (existingApptForBook) {
          // Tentar atualizar o existente primeiro (evita duplicatas)
          try {
            await client.put(`/calendars/events/appointments/${existingApptForBook.id}`, {
              calendarId: bookCalendarId,
              startTime: action.start_time,
              title: action.title || existingApptForBook.title,
              ...(meetingLoc ?? {}),
            });
            await tagBookedByAi(client, ctx.contactId); // tag interna (ver nota abaixo)
            break;
          } catch {
            try {
              await client.delete(`/calendars/events/appointments/${existingApptForBook.id}`);
            } catch {
              console.warn("[BookAppointment] Could not delete existing, creating new (may duplicate)");
            }
          }
        }

        try {
          await client.post("/calendars/events/appointments", {
            calendarId: bookCalendarId,
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: action.title || "Reunião agendada",
            ...(meetingLoc ?? { meetingLocationType: "phone" }),
          });
          // Tag interna "agendado pela ia" (Pedro 2026-06-22): rastreia no CRM que
          // a IA agendou, SEM poluir o título/convite da reunião. Non-blocking.
          await tagBookedByAi(client, ctx.contactId);
        } catch (bookingError) {
          // Re-classify slot/availability errors with an actionable message
          if (bookingError instanceof Error &&
              (bookingError.message.includes("available") || bookingError.message.includes("slot") || bookingError.message.includes("422"))) {
            console.log("[BookAppointment] Slot unavailable, attempting next slot...");
            throw new Error("Calendario nao configurado ou horario indisponivel");
          }
          throw bookingError;
        }
      }
      break;
    }

    case "reschedule_appointment":
      if (action.start_time) {
        // FIX CRITICAL stress test 2026-05-03: usar appointment_id explícito
        // se a IA passou. Antes ignorava e re-buscava — em contatos com 2+
        // appointments futuros (multi-calendar), reagendava o ERRADO.
        let targetApptId: string | undefined;
        let targetCalId: string | undefined;
        let targetTitle: string | undefined;
        if (action.appointment_id && /^[A-Za-z0-9]{18,}$/.test(String(action.appointment_id))) {
          targetApptId = String(action.appointment_id);
          targetCalId = action.calendar_id ? String(action.calendar_id) : undefined;
          targetTitle = action.title ? String(action.title) : undefined;
        } else {
          const existingAppt = await findExistingAppointment(client, ctx.contactId, ctx.locationId);
          if (existingAppt) {
            targetApptId = existingAppt.id;
            targetCalId = existingAppt.calendarId;
            targetTitle = existingAppt.title;
          }
        }

        if (targetApptId) {
          try {
            await client.delete(`/calendars/events/appointments/${targetApptId}`);
          } catch {
            // Se falhar ao deletar, continua e cria novo
          }
          await client.post("/calendars/events/appointments", {
            calendarId: ctx.calendarId || targetCalId,
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: targetTitle || "Reunião reagendada",
            ...(resolveMeetingLocation(ctx.calendarId || targetCalId) ?? { meetingLocationType: "phone" }),
          });
        } else {
          await client.post("/calendars/events/appointments", {
            calendarId: action.calendar_id || "",
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: "Reuniao agendada via AI",
            ...(resolveMeetingLocation(action.calendar_id) ?? { meetingLocationType: "phone" }),
          });
        }
      }
      break;

    case "move_pipeline":
      if (action.pipeline_id && action.stage_id) {
        // Fix bug observado em prod 2026-06-10: move_pipeline fazia
        // PUT /opportunities/ sem oppId → 4xx → throw silencioso → etapa
        // NUNCA mudava (lead recebia "movi você" sem ter movido). A GHL
        // exige o oppId no path; resolvemos a opp do contato antes do PUT.
        const oppId = await findContactOpportunityId(
          client,
          ctx.locationId,
          ctx.contactId,
          action.pipeline_id,
        );
        if (!oppId) {
          console.warn(
            `[ActionExecutor] move_pipeline: contato ${ctx.contactId} sem opportunity no Spark Leads — skip`,
          );
          break;
        }
        await updateOpportunity(client, oppId, {
          pipelineId: action.pipeline_id,
          pipelineStageId: action.stage_id,
        });
      }
      break;

    case "send_message":
      break;
  }
}

/**
 * Marca no CRM que o agendamento foi feito pela IA — tag INTERNA, não aparece no
 * título/convite da reunião (Pedro 2026-06-22: tirou "via AI" do invite e pediu
 * o rastro via tag na automação). Non-blocking: o booking já aconteceu; se a tag
 * falhar, só loga (não derruba o fluxo).
 */
async function tagBookedByAi(client: GHLClient, contactId: string): Promise<void> {
  try {
    await addTagsToContact(client, contactId, ["agendado pela ia"]);
  } catch (e) {
    console.warn(
      "[BookAppointment] falha ao adicionar tag 'agendado pela ia' (non-blocking):",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Busca appointment existente (futuro) para um contato.
 * Tenta multiplos endpoints da GHL API.
 */
async function findExistingAppointment(
  client: GHLClient,
  contactId: string,
  locationId: string
): Promise<{ id: string; title: string; calendarId: string; startTime: string } | null> {
  // H6 (review 2026-04-28): GHL API tem formato variável; antes deste fix,
  // chamávamos os 3 endpoints SEQUENCIAL (~400ms p99 desnecessário em
  // booking flow). Agora rodamos os 3 em paralelo e pegamos o primeiro
  // que retorna um appointment futuro válido.
  type AppointmentItem = { id: string; title: string; calendarId: string; startTime: string; status?: string; appointmentStatus?: string };

  const endpoints = [
    { path: `/contacts/${contactId}/appointments`, params: { locationId } as Record<string, string> },
    { path: "/calendars/events/appointments", params: { locationId, contactId } as Record<string, string> },
    { path: "/calendars/events", params: { locationId, contactId } as Record<string, string> },
  ];

  const now = new Date();

  // Paraleliza todas as chamadas. Cada Promise resolve com o primeiro
  // appointment futuro válido daquele endpoint (ou null se não houver).
  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const result = await client.get<Record<string, unknown>>(ep.path, ep.params);
      const items: AppointmentItem[] =
        (result.events as AppointmentItem[]) ||
        (result.appointments as AppointmentItem[]) ||
        (result.data as AppointmentItem[]) ||
        [];

      console.log(`[FindAppointment] ${ep.path} returned ${items.length} items`);

      if (items.length === 0) return null;
      const future = items.find((e) => {
        const start = new Date(e.startTime);
        const status = (e.status || e.appointmentStatus || "").toLowerCase();
        return start > now && status !== "cancelled" && status !== "deleted";
      });
      return future || null;
    }),
  );

  // Prioridade pelo ordem dos endpoints (primeiro endpoint que retornou
  // resultado válido vence). Mantém comportamento legado.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      console.log(`[FindAppointment] Found via ${endpoints[i].path}: ${r.value.id} at ${r.value.startTime}`);
      return r.value;
    }
    if (r.status === "rejected") {
      console.log(
        `[FindAppointment] ${endpoints[i].path} failed:`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  }

  console.log("[FindAppointment] No future appointments found for contact", contactId);
  return null;
}

async function updateConversationState(
  supabase: ReturnType<typeof createAdminClient>,
  ctx: ExecutionContext,
  response: AIResponse
): Promise<void> {
  // Merge collected_data com dados existentes (nao sobrescreve campos anteriores)
  const { data: existing } = await supabase
    .from("conversation_state")
    .select("collected_data, message_count, summary_note_id, segment_number")
    .eq("agent_id", ctx.agentId)
    .eq("contact_id", ctx.contactId)
    .maybeSingle();

  const previousData = (existing?.collected_data as Record<string, string>) || {};
  const mergedData = { ...previousData, ...response.collected_data };

  // Se conversa tinha nota de resumo, iniciar novo segmento
  const existingFull = existing as Record<string, unknown> | null;
  const hadSummary = existingFull?.summary_note_id && existingFull.summary_note_id !== "generating";
  const segmentReset = hadSummary ? {
    summary_note_id: null,
    summary_note_created_at: null,
    segment_number: ((existingFull?.segment_number as number) || 1) + 1,
    ai_paused_at: null,
    ai_paused_reason: null,
  } : {};

  await supabase
    .from("conversation_state")
    .upsert(
      {
        agent_id: ctx.agentId,
        location_id: ctx.locationId,
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        status: response.conversation_status,
        collected_data: mergedData,
        message_count: (existing?.message_count || 0) + 1,
        last_ai_response_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...segmentReset,
      },
      { onConflict: "agent_id,contact_id" }
    );
}

async function logExecution(
  supabase: ReturnType<typeof createAdminClient>,
  ctx: ExecutionContext,
  actionType: string,
  payload: Record<string, unknown>,
  success = true,
  error?: unknown
): Promise<void> {
  await supabase.from("execution_log").insert({
    agent_id: ctx.agentId,
    conversation_id: ctx.conversationId,
    contact_id: ctx.contactId,
    location_id: ctx.locationId,
    action_type: actionType,
    action_payload: payload,
    success,
    error_message: error instanceof Error ? error.message : error ? String(error) : null,
  });
}
