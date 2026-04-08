import { GHLClient } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";
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
}

// Mapeia canal para o "type" da API de mensagens do GHL
function channelToMessageType(channel?: string): string {
  switch (channel) {
    case "WhatsApp": return "WhatsApp";
    case "Instagram": return "IG";
    case "Email": return "Email";
    default: return "SMS";
  }
}

export async function executeActions(
  response: AIResponse,
  ctx: ExecutionContext
): Promise<void> {
  const client = new GHLClient(ctx.companyId, ctx.locationId);
  const supabase = createAdminClient();

  const messageType = channelToMessageType(ctx.channel);

  // 1. Executar acoes PRIMEIRO (book, reschedule, update fields, tags)
  let actionsFailed = false;
  let failedActionError = "";

  for (const action of response.actions) {
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
  const messages = normalizeMessages(response.message);

  if (!ctx.skipSendMessage && messages.length > 0) {
    try {
      // Se um agendamento/reagendamento falhou, avisar o lead
      if (actionsFailed && failedActionError.includes("no longer available")) {
        const errorMsg = "Desculpa, esse horario nao esta mais disponivel. Posso sugerir outro?";
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
    }
  }

  // 3. Atualizar conversation_state
  await updateConversationState(supabase, ctx, response);
}

async function executeAction(
  client: GHLClient,
  action: AIAction,
  ctx: ExecutionContext
): Promise<void> {
  switch (action.type) {
    case "update_field":
      if (action.field_key && action.value) {
        // Campos padrao do contato (contact.firstName, contact.phone, etc.)
        if (action.field_key.startsWith("contact.")) {
          const fieldName = action.field_key.replace("contact.", "");
          await client.put(`/contacts/${ctx.contactId}`, {
            [fieldName]: action.value,
          });
        } else {
          // Custom field
          await client.put(`/contacts/${ctx.contactId}`, {
            customFields: [{ id: action.field_key, value: action.value }],
          });
        }
      }
      break;

    case "add_tag":
      if (action.tag) {
        await client.post(`/contacts/${ctx.contactId}/tags`, {
          tags: [action.tag],
        });
      }
      break;

    case "remove_tag":
      if (action.tag) {
        await client.delete(`/contacts/${ctx.contactId}/tags`, {
          tags: [action.tag],
        });
      }
      break;

    case "book_appointment": {
      // SEMPRE usar calendarId do config, nao o que a IA inventou
      const bookCalendarId = ctx.calendarId || action.calendar_id;
      if (bookCalendarId && action.start_time) {
        const existingApptForBook = await findExistingAppointment(client, ctx.contactId, ctx.locationId);

        if (existingApptForBook) {
          // Tentar atualizar o existente primeiro (evita duplicatas)
          try {
            await client.put(`/calendars/events/appointments/${existingApptForBook.id}`, {
              calendarId: bookCalendarId,
              startTime: action.start_time,
              title: action.title || existingApptForBook.title,
            });
            break;
          } catch {
            try {
              await client.delete(`/calendars/events/appointments/${existingApptForBook.id}`);
            } catch {
              console.warn("[BookAppointment] Could not delete existing, creating new (may duplicate)");
            }
          }
        }

        await client.post("/calendars/events/appointments", {
          calendarId: bookCalendarId,
          locationId: ctx.locationId,
          contactId: ctx.contactId,
          startTime: action.start_time,
          title: action.title || "Reuniao agendada via AI",
          meetingLocationType: "phone",
        });
      }
      break;
    }

    case "reschedule_appointment":
      if (action.start_time) {
        const existingAppt = await findExistingAppointment(client, ctx.contactId, ctx.locationId);
        if (existingAppt) {
          // Deletar o appointment antigo e criar um novo (mais confiavel que PUT)
          try {
            await client.delete(`/calendars/events/appointments/${existingAppt.id}`);
          } catch {
            // Se falhar ao deletar, continua e cria novo
          }
          // Criar novo appointment com o novo horario
          await client.post("/calendars/events/appointments", {
            calendarId: ctx.calendarId || action.calendar_id || existingAppt.calendarId,
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: existingAppt.title || "Reuniao reagendada via AI",
            meetingLocationType: "phone",
          });
        } else {
          await client.post("/calendars/events/appointments", {
            calendarId: action.calendar_id || "",
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: "Reuniao agendada via AI",
            meetingLocationType: "phone",
          });
        }
      }
      break;

    case "move_pipeline":
      if (action.pipeline_id && action.stage_id) {
        await client.put(`/opportunities/`, {
          pipelineId: action.pipeline_id,
          pipelineStageId: action.stage_id,
          contactId: ctx.contactId,
          locationId: ctx.locationId,
        });
      }
      break;

    case "send_message":
      break;
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
  type AppointmentItem = { id: string; title: string; calendarId: string; startTime: string; status?: string; appointmentStatus?: string };

  const endpoints = [
    { path: `/contacts/${contactId}/appointments`, params: { locationId } as Record<string, string> },
    { path: "/calendars/events/appointments", params: { locationId, contactId } as Record<string, string> },
    { path: "/calendars/events", params: { locationId, contactId } as Record<string, string> },
  ];

  for (const ep of endpoints) {
    try {
      const result = await client.get<Record<string, unknown>>(ep.path, ep.params);

      // GHL pode retornar em diferentes formatos
      const items: AppointmentItem[] =
        (result.events as AppointmentItem[]) ||
        (result.appointments as AppointmentItem[]) ||
        (result.data as AppointmentItem[]) ||
        [];

      console.log(`[FindAppointment] ${ep.path} returned ${items.length} items`);

      if (items.length > 0) {
        const now = new Date();
        const future = items.find((e) => {
          const start = new Date(e.startTime);
          const status = (e.status || e.appointmentStatus || "").toLowerCase();
          return start > now && status !== "cancelled" && status !== "deleted";
        });

        if (future) {
          console.log(`[FindAppointment] Found: ${future.id} at ${future.startTime}`);
          return future;
        }
      }
    } catch (err) {
      console.log(`[FindAppointment] ${ep.path} failed:`, err instanceof Error ? err.message : err);
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
  await supabase
    .from("conversation_state")
    .upsert(
      {
        agent_id: ctx.agentId,
        location_id: ctx.locationId,
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        status: response.conversation_status,
        collected_data: response.collected_data,
        last_ai_response_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
