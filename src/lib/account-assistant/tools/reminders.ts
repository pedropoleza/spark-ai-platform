/**
 * Tools de Reminders/Schedule do Sparkbot.
 *
 * Diferente de create_task (que cria task no GHL pro rep ver no CRM),
 * estas ferramentas agendam mensagens proativas DO PRÓPRIO Sparkbot.
 *
 * Use cases:
 *   - "me lembra amanhã 10h de revisar o pipeline" → schedule_reminder
 *   - "todo dia 18h me manda os fechamentos do dia" → schedule_reminder com recurrence
 *   - "lista meus lembretes" → list_my_reminders
 *   - "cancela aquele lembrete da sexta" → cancel_reminder
 *
 * Persistência: tabela assistant_scheduled_tasks (criada na migration 00029).
 * Execução: cron /api/cron/sparkbot-proactive a cada 5min.
 */

import type { ToolEntry } from "./types";
import { validateGhlId, validateIso8601 } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";

const scheduleReminder: ToolEntry = {
  def: {
    name: "schedule_reminder",
    description:
      "Agenda uma mensagem proativa do Sparkbot pro rep no horário combinado. Use quando o rep pedir 'me lembra/avisa em X', 'todo dia/sexta às Y, me manda Z'. NÃO confunda com create_task (que cria task no CRM, visível no GHL). Reminder = msg do Sparkbot.\n\nCANAL DE ENTREGA (delivery_channel):\n- Se rep tá no WhatsApp: passe 'whatsapp' (default).\n- Se rep tá no Web UI (painel no GHL): PERGUNTE primeiro 'computador, celular ou ambos?' e mapeie pra 'web_ui'/'whatsapp'/'both' antes de chamar a tool.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Texto curto que o Sparkbot vai mandar no horário marcado. Ex: 'lembrete: revisar pipeline'.",
        },
        remind_at: {
          type: "string",
          description:
            "ISO 8601 com timezone. Quando deve disparar a primeira (ou única) vez. Ex: '2026-04-28T10:00:00-04:00'.",
        },
        recurrence: {
          type: "string",
          description:
            "OPCIONAL. Cron expression simples pra recorrência (formato '<min> <hour> * * <dow>'). Ex: '0 18 * * 1-5' = todo dia útil 18h. Omita pra one-shot.",
        },
        title: {
          type: "string",
          description: "Título curto pra mostrar em list_my_reminders. Default: primeiros 40 chars do message.",
        },
        delivery_channel: {
          type: "string",
          enum: ["whatsapp", "web_ui", "both"],
          description:
            "Onde entregar o lembrete. 'whatsapp' = WhatsApp do rep (default p/ requests vindos do WhatsApp). 'web_ui' = só no painel do GHL (computador). 'both' = nos dois lugares. Pra requests vindos do Web UI, PERGUNTE ao rep antes de chamar.",
        },
      },
      required: ["message", "remind_at"],
    },
  },
  handler: async (ctx, args) => {
    const message = String(args.message || "").trim();
    if (!message) return { status: "error", message: "message obrigatória", retryable: false };
    const remindAt = String(args.remind_at || "");
    const dateInvalid = validateIso8601(remindAt, "remind_at");
    if (dateInvalid) return dateInvalid;
    const isoRemind = new Date(remindAt).toISOString();
    if (new Date(isoRemind).getTime() < Date.now() - 60 * 1000) {
      return {
        status: "error",
        message: "remind_at no passado. Use uma data/hora futura.",
        retryable: false,
      };
    }
    const recurrence = args.recurrence ? String(args.recurrence).trim() : null;
    if (recurrence && !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(recurrence)) {
      return {
        status: "error",
        message: "recurrence inválida. Use cron de 5 campos: '<min> <hour> * * <dow>'.",
        retryable: false,
      };
    }
    const title = args.title
      ? String(args.title).slice(0, 100)
      : message.slice(0, 40) + (message.length > 40 ? "…" : "");

    // delivery_channel: respeita o que LLM passou; senão usa o canal atual
    // do contexto como default. Importante: pra Web UI, prompt-builder
    // ensinou o LLM a perguntar antes — se chegou 'whatsapp' aqui veio do WA.
    const requestedChannel = args.delivery_channel ? String(args.delivery_channel) : null;
    const validChannels = ["whatsapp", "web_ui", "both"];
    const deliveryChannel = requestedChannel && validChannels.includes(requestedChannel)
      ? requestedChannel
      : (ctx.confirmationMode ? "whatsapp" : "whatsapp"); // default whatsapp

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("assistant_scheduled_tasks")
      .insert({
        rep_id: ctx.rep.id,
        location_id: ctx.locationId,
        task_type: recurrence ? "recurring_reminder" : "reminder",
        task_payload: {
          message,
          title,
          source: "rep_request",
          test_session_id: ctx.testSessionId || null,
        },
        next_run_at: isoRemind,
        cron_expr: recurrence,
        delivery_channel: deliveryChannel,
        status: "pending",
      })
      .select("id, next_run_at, delivery_channel")
      .single();

    if (error) {
      return { status: "error", message: `Falha ao agendar: ${error.message}`, retryable: false };
    }
    return {
      status: "ok",
      data: {
        reminder_id: data.id,
        next_run_at: data.next_run_at,
        recurrence: recurrence || null,
        delivery_channel: data.delivery_channel,
        title,
      },
    };
  },
};

const listMyReminders: ToolEntry = {
  def: {
    name: "list_my_reminders",
    description: "Lista lembretes pendentes do rep (agendados via schedule_reminder).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        include_recurring: {
          type: "boolean",
          description: "Incluir recorrentes além de one-shot. Default true.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const includeRecurring = args.include_recurring !== false;
    const supabase = createAdminClient();

    const types = includeRecurring ? ["reminder", "recurring_reminder"] : ["reminder"];
    const { data, error } = await supabase
      .from("assistant_scheduled_tasks")
      .select("id, task_type, task_payload, next_run_at, cron_expr, status, last_run_at")
      .eq("rep_id", ctx.rep.id)
      .eq("status", "pending")
      .in("task_type", types)
      .order("next_run_at", { ascending: true })
      .limit(50);

    if (error) {
      return { status: "error", message: `Falha ao listar: ${error.message}`, retryable: false };
    }

    return {
      status: "ok",
      data: (data || []).map((t) => {
        const payload = (t.task_payload || {}) as { title?: string; message?: string };
        return {
          id: t.id,
          title: payload.title || (payload.message || "").slice(0, 40),
          message: payload.message,
          next_run_at: t.next_run_at,
          recurrence: t.cron_expr || null,
          last_run_at: t.last_run_at || null,
          is_recurring: t.task_type === "recurring_reminder",
        };
      }),
    };
  },
};

const cancelReminder: ToolEntry = {
  def: {
    name: "cancel_reminder",
    description: "Cancela um lembrete pendente. Pra recorrentes, para todas as repetições futuras.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        reminder_id: {
          type: "string",
          description:
            "ID do lembrete. Use list_my_reminders pra obter. NUNCA invente.",
        },
      },
      required: ["reminder_id"],
    },
  },
  handler: async (ctx, args) => {
    const reminderId = String(args.reminder_id || "");
    const invalid = validateGhlId(reminderId, "reminder");
    if (invalid) return invalid;

    const supabase = createAdminClient();
    // Garante que o lembrete pertence ao rep (segurança)
    const { data: existing } = await supabase
      .from("assistant_scheduled_tasks")
      .select("id, rep_id, status")
      .eq("id", reminderId)
      .maybeSingle();
    if (!existing) return { status: "not_found", message: `Reminder ${reminderId} não existe` };
    if (existing.rep_id !== ctx.rep.id) {
      return { status: "error", message: "Reminder não pertence a você", retryable: false };
    }
    if (existing.status !== "pending") {
      return {
        status: "error",
        message: `Reminder já está '${existing.status}', não dá pra cancelar`,
        retryable: false,
      };
    }

    const { error } = await supabase
      .from("assistant_scheduled_tasks")
      .update({ status: "cancelled" })
      .eq("id", reminderId);
    if (error) {
      return { status: "error", message: `Falha ao cancelar: ${error.message}`, retryable: false };
    }
    return { status: "ok", data: { cancelled: reminderId } };
  },
};

export const REMINDERS_TOOLS: ToolEntry[] = [scheduleReminder, listMyReminders, cancelReminder];
