/**
 * Tools de Conversas/Mensagens.
 *
 * send_message_to_contact é HIGH RISK — sempre pede confirmação simples
 * (confirmation_mode='medium_and_high' ou 'always' captura).
 */

import type { ToolEntry } from "./types";
import { validateGhlId, ghlErrorToResult } from "./types";

const searchConversations: ToolEntry = {
  def: {
    name: "search_conversations",
    description: "Busca a conversa de um contato (uma só por contato). Use pra obter conversation_id.",
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
      return {
        status: "ok",
        data: (res.conversations || []).map((c) => ({
          id: c.id,
          contact_id: c.contactId,
          last_message_at: c.lastMessageDate,
          unread_count: c.unreadCount || 0,
          type: c.type,
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
            "Canal de envio. Default 'SMS' (= WhatsApp Web / SMS via Stevo/Evolution — funciona pra TODOS os contatos). 'WhatsApp' = WhatsApp API oficial (só funciona se o rep tem WhatsApp Business API ativo). 'Email' / 'IG' = canais alternativos.",
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
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "envio de mensagem");
    }
  },
};

export const MESSAGES_TOOLS: ToolEntry[] = [
  searchConversations,
  getConversationHistory,
  sendMessageToContact,
];
