/**
 * Tools de Conversas/Mensagens.
 *
 * send_message_to_contact é HIGH RISK — sempre pede confirmação simples
 * (confirmation_mode='medium_and_high' ou 'always' captura).
 */

import type { ToolEntry } from "./types";
import { validateGhlId, validateIso8601, getRepGhlUserId, ghlErrorToResult } from "./types";
import { ensureContactAssignedTo } from "@/lib/ghl/operations";

const searchConversations: ToolEntry = {
  def: {
    name: "search_conversations",
    description:
      "Lista conversas de um contato no Spark Leads. Pode haver MÚLTIPLAS (1 por canal: SMS, WhatsApp, Email, IG). Cada item tem `type` indicando o canal — use o type apropriado pra escolher conversation_id certo. Use pra obter conversation_id antes de chamar get_conversation_history.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        conversations?: Array<{
          id: string; contactId: string; lastMessageDate?: string;
          unreadCount?: number; type?: string;
        }>;
      }>("/conversations/search", { locationId: ctx.locationId, contactId });
      // Fix Track 3 CRITICAL #1 (review 2026-05-05): defesa em profundidade —
      // filtra resultado garantindo que contactId bate com requested. GHL
      // pode retornar conversas cross-tenant em edge cases (especialmente
      // após merge/migration); filtro client-side previne vazamento.
      const conversations = (res.conversations || []).filter(
        (c) => c.contactId === contactId,
      );
      if (conversations.length === 0) {
        return {
          status: "not_found",
          message: `Nenhuma conversa encontrada pro contato ${contactId} nessa location.`,
        };
      }
      return {
        status: "ok",
        data: conversations.map((c) => ({
          id: c.id,
          contact_id: c.contactId,
          last_message_at: c.lastMessageDate,
          unread_count: c.unreadCount || 0,
          type: c.type || "unknown",
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "busca de conversa");
    }
  },
};

const getConversationHistory: ToolEntry = {
  def: {
    name: "get_conversation_history",
    description:
      "Lê histórico de mensagens entre o rep e um contato. Use pra contextualizar antes de mandar msg ou pra resumir o que conversaram.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Use search_conversations pra obter." },
        limit: { type: "number", description: "Max msgs (default 30, max 100).", default: 30 },
      },
      required: ["conversation_id"],
    },
  },
  handler: async (ctx, args) => {
    const conversationId = String(args.conversation_id || "");
    const invalid = validateGhlId(conversationId, "conversation");
    if (invalid) return invalid;
    const limit = Math.min(Number(args.limit) || 30, 100);

    try {
      const res = await ctx.ghlClient.get<{
        messages?: {
          messages?: Array<{
            id: string; direction: string; body?: string; messageType?: string;
            dateAdded: string; status?: string; userId?: string;
          }>;
        };
      }>(`/conversations/${conversationId}/messages`, {
        locationId: ctx.locationId,
        limit: String(limit),
      });
      const msgs = res.messages?.messages || [];
      return {
        status: "ok",
        data: msgs.slice(-limit).map((m) => ({
          id: m.id,
          direction: m.direction,
          body: m.body || "",
          type: m.messageType,
          status: m.status,
          author_id: m.userId,
          created_at: m.dateAdded,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de histórico de conversa");
    }
  },
};

const sendMessageToContact: ToolEntry = {
  def: {
    name: "send_message_to_contact",
    description:
      "🚨 AÇÃO AVANÇADA — envia mensagem REAL pra um lead/cliente em nome do rep. SEMPRE peça confirmação ANTES de chamar essa tool. Avise o rep com algo como: 'Vou mandar [resumo da msg] pro [nome do contato] via [canal]. Confirma? (Essa é uma ação avançada, preciso da sua confirmação)'.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        message: { type: "string", description: "Texto da mensagem." },
        channel: {
          type: "string",
          enum: ["SMS", "WhatsApp", "Email", "IG"],
          description:
            "Canal de envio. Default 'SMS' (= WhatsApp Web / SMS via Stevo/Evolution — funciona pra TODOS os contatos). 'WhatsApp' = WhatsApp API oficial (⚠️ só funciona se a sub-account tem WhatsApp Business API ATIVADA — caso não tenha, Spark Leads retorna erro; nesse caso use 'SMS'). 'Email' / 'IG' = canais alternativos.",
        },
        subject: { type: "string", description: "Subject (apenas pra Email)." },
      },
      required: ["contact_id", "message"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const message = String(args.message || "").trim();
    if (!message) return { status: "error", message: "message obrigatória", retryable: false };
    const channel = String(args.channel || "SMS");
    const validChannels = ["SMS", "WhatsApp", "Email", "IG"];
    if (!validChannels.includes(channel)) {
      return { status: "error", message: `channel inválido (use ${validChannels.join("|")})`, retryable: false };
    }

    // Fix Pedro 2026-05-06: PROTOCOLO PADRÃO — antes de QUALQUER send,
    // garante que o assignedTo do contato é o rep que pediu. Pra contas
    // com múltiplas instâncias WhatsApp ativas, GHL roteia outbound baseado
    // no assignedTo. Sem isso, msg pode sair pelo número de outro rep.
    let assignmentChanged = false;
    let previousAssignee: string | null = null;
    const repUserId = getRepGhlUserId(ctx);
    if (repUserId) {
      try {
        const r = await ensureContactAssignedTo(ctx.ghlClient, contactId, repUserId);
        assignmentChanged = r.changed;
        previousAssignee = r.previousAssignedTo;
      } catch (err) {
        // Não fatal — segue tentando o send. Log pra audit.
        console.warn(
          `[send_message_to_contact] assignedTo update falhou (não fatal):`,
          err instanceof Error ? err.message.slice(0, 100) : err,
        );
      }
    }

    try {
      const body: Record<string, unknown> = {
        type: channel,
        contactId,
        message,
        ...(channel === "Email" && args.subject ? { subject: String(args.subject) } : {}),
      };
      const res = await ctx.ghlClient.post<{ messageId?: string; conversationId?: string }>(
        "/conversations/messages",
        body,
      );
      return {
        status: "ok",
        data: {
          message_id: res.messageId,
          conversation_id: res.conversationId,
          channel,
          assigned_to: repUserId || null,
          assignment_changed: assignmentChanged,
          previous_assignee: previousAssignee,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "envio de mensagem");
    }
  },
};

// ============================================================
// SCHEDULED MESSAGES TO CONTACT
// ============================================================
// Diferente de schedule_reminder (que manda pro REP), estas tools
// agendam mensagens pra um CONTATO/LEAD específico em horário X.
// Use case Pedro 2026-05-06: "manda mensagem pra Maria amanhã 10h".
//
// Persistência: assistant_scheduled_tasks task_type='outbound_to_contact'.
// Execução: cron sparkbot-proactive → reminder-runner.ts switch
// extends pra esse task_type → POST GHL /conversations/messages.

const scheduleMessageToContact: ToolEntry = {
  def: {
    name: "schedule_message_to_contact",
    description:
      "🚨 AÇÃO AVANÇADA — agenda mensagem REAL pra um lead/cliente em horário futuro (one-shot OU recorrente). SEMPRE peça confirmação ANTES (ex: 'Vou agendar a msg \"X\" pra mandar pra [nome] amanhã 10h via SMS. Confirma?').\n\nUse quando rep pede: 'manda pra Maria amanhã 9h', 'todo dia 18h envia X pra cliente Y', 'segunda que vem fala com fulano sobre Z'.\n\nDiferenças de outras tools:\n- `send_message_to_contact` envia AGORA (não tem agendamento)\n- `schedule_reminder` envia pro REP, não pra contato\n- `schedule_bulk_message` envia pra LISTA (filter por tag) com drip — não single contato\n\nNo horário marcado, cron SparkBot dispara `send_message_to_contact` automaticamente (mesma rota POST /conversations/messages). Bot avisa rep se delivery falhou.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        contact_id: {
          type: "string",
          description: "ID do contato no Spark Leads (use search_contacts antes).",
        },
        message: {
          type: "string",
          description: "Texto que vai ser enviado pro contato no horário marcado.",
        },
        send_at: {
          type: "string",
          description:
            "ISO 8601 com offset. Ex: '2026-05-07T10:00:00-04:00' = 7 de maio 10h NY. Pra recurring, é a 1ª execução.",
        },
        recurrence: {
          type: "string",
          description:
            "OPCIONAL. Cron 5 campos pra recorrência. Ex: '0 9 * * 1-5' = todo dia útil 9h. Omita pra one-shot.",
        },
        channel: {
          type: "string",
          enum: ["SMS", "WhatsApp", "Email", "IG"],
          description:
            "Canal de envio. Default 'SMS' (= WhatsApp via Stevo). 'WhatsApp' só se sub-account tem WhatsApp Business API ativada.",
        },
        subject: {
          type: "string",
          description: "OPCIONAL. Subject (apenas pra Email).",
        },
      },
      required: ["contact_id", "message", "send_at"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    const message = String(args.message || "").trim();
    if (!message)
      return { status: "error", message: "message obrigatória", retryable: false };

    const sendAt = String(args.send_at || "");
    const dateInvalid = validateIso8601(sendAt, "send_at");
    if (dateInvalid) return dateInvalid;
    const isoSend = new Date(sendAt).toISOString();
    if (new Date(isoSend).getTime() < Date.now() - 60 * 1000) {
      return {
        status: "error",
        message: "send_at no passado. Use uma data/hora futura.",
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

    const channel = String(args.channel || "SMS");
    const validChannels = ["SMS", "WhatsApp", "Email", "IG"];
    if (!validChannels.includes(channel)) {
      return {
        status: "error",
        message: `channel inválido (use ${validChannels.join("|")})`,
        retryable: false,
      };
    }

    try {
      const supabase = (await import("@/lib/supabase/admin")).createAdminClient();
      const { data, error } = await supabase
        .from("assistant_scheduled_tasks")
        .insert({
          rep_id: ctx.rep.id,
          location_id: ctx.locationId,
          task_type: recurrence
            ? "outbound_to_contact_recurring"
            : "outbound_to_contact",
          task_payload: {
            contact_id: contactId,
            message,
            channel,
            ...(args.subject ? { subject: String(args.subject) } : {}),
            source: "rep_request",
            scheduled_by_rep_id: ctx.rep.id,
          },
          next_run_at: isoSend,
          cron_expr: recurrence,
          delivery_channel: "whatsapp", // canal do REP pra ack/error, não do contato
          status: "pending",
        })
        .select("id, next_run_at")
        .single();
      if (error) {
        return {
          status: "error",
          message: `falha ao agendar: ${error.message}`,
          retryable: false,
        };
      }
      return {
        status: "ok",
        data: {
          scheduled_id: data.id,
          contact_id: contactId,
          send_at: data.next_run_at,
          channel,
          recurring: !!recurrence,
          recurrence: recurrence || null,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "agendamento de mensagem pra contato");
    }
  },
};

const cancelScheduledMessage: ToolEntry = {
  def: {
    name: "cancel_scheduled_message",
    description:
      "Cancela uma mensagem agendada pra contato (criada por `schedule_message_to_contact`). Use quando rep pedir 'cancela aquela mensagem pra X' ou 'não manda mais o lembrete recorrente Y'.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        scheduled_id: {
          type: "string",
          description: "ID retornado por schedule_message_to_contact OU list_scheduled_messages.",
        },
      },
      required: ["scheduled_id"],
    },
  },
  handler: async (ctx, args) => {
    const id = String(args.scheduled_id || "");
    // UUID v4 validation — assistant_scheduled_tasks.id é uuid
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return {
        status: "error",
        message: "scheduled_id inválido (esperado UUID).",
        retryable: false,
      };
    }
    try {
      const supabase = (await import("@/lib/supabase/admin")).createAdminClient();
      const { data, error } = await supabase
        .from("assistant_scheduled_tasks")
        .update({ status: "cancelled" })
        .eq("id", id)
        .eq("rep_id", ctx.rep.id) // só cancela tarefas DO rep que pediu
        .in("task_type", ["outbound_to_contact", "outbound_to_contact_recurring"])
        .in("status", ["pending", "active"])
        .select("id, task_payload")
        .maybeSingle();
      if (error) {
        return {
          status: "error",
          message: `falha ao cancelar: ${error.message}`,
          retryable: false,
        };
      }
      if (!data) {
        return {
          status: "not_found",
          message: "Nenhuma msg agendada com esse id (ou já cancelada/executada, ou é de outro rep).",
        };
      }
      return {
        status: "ok",
        data: {
          cancelled_id: data.id,
          contact_id:
            (data.task_payload as { contact_id?: string })?.contact_id || null,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "cancelamento de mensagem agendada");
    }
  },
};

const listScheduledMessages: ToolEntry = {
  def: {
    name: "list_scheduled_messages",
    description:
      "Lista mensagens agendadas pelo rep pra contatos (não executadas ainda). Use quando rep perguntar 'o que tenho agendado?', 'lista os disparos futuros', 'tem mensagem marcada pra fulano?'.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        contact_id: {
          type: "string",
          description: "OPCIONAL. Filtra só agendamentos pra esse contato.",
        },
        limit: {
          type: "number",
          description: "Default 20, max 50.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Number(args.limit) || 20, 50);
    const contactIdFilter = args.contact_id ? String(args.contact_id) : null;
    if (contactIdFilter) {
      const invalid = validateGhlId(contactIdFilter, "contact");
      if (invalid) return invalid;
    }
    try {
      const supabase = (await import("@/lib/supabase/admin")).createAdminClient();
      let q = supabase
        .from("assistant_scheduled_tasks")
        .select("id, task_type, task_payload, next_run_at, cron_expr, status")
        .eq("rep_id", ctx.rep.id)
        .in("task_type", ["outbound_to_contact", "outbound_to_contact_recurring"])
        .in("status", ["pending", "active"])
        .order("next_run_at", { ascending: true })
        .limit(limit);
      if (contactIdFilter) {
        q = q.contains("task_payload", { contact_id: contactIdFilter });
      }
      const { data, error } = await q;
      if (error) {
        return {
          status: "error",
          message: `query falhou: ${error.message}`,
          retryable: false,
        };
      }
      if (!data || data.length === 0) {
        return {
          status: "not_found",
          message: contactIdFilter
            ? `Nenhuma msg agendada pra esse contato.`
            : `Você não tem mensagens agendadas pendentes.`,
        };
      }
      return {
        status: "ok",
        data: data.map((row) => {
          const p = row.task_payload as {
            contact_id?: string;
            message?: string;
            channel?: string;
          };
          return {
            scheduled_id: row.id,
            contact_id: p.contact_id || null,
            message_preview: (p.message || "").slice(0, 100),
            channel: p.channel || "SMS",
            send_at: row.next_run_at,
            recurring: row.task_type === "outbound_to_contact_recurring",
            cron_expr: row.cron_expr || null,
          };
        }),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de mensagens agendadas");
    }
  },
};

export const MESSAGES_TOOLS: ToolEntry[] = [
  searchConversations,
  getConversationHistory,
  sendMessageToContact,
  scheduleMessageToContact,
  cancelScheduledMessage,
  listScheduledMessages,
];
