/**
 * Busca mensagens de conversa entre rep e contato pra contexto follow-up
 * (Pedro 2026-05-18).
 *
 * Combina:
 *   - GHL /conversations (WhatsApp/SMS) — fonte primária pra leads/clientes
 *   - sparkbot_messages — pro caso de rep + bot (web UI)
 *
 * Output cru pra ser passado pro summarizer. Inclui métricas determinísticas
 * que o spam-score usa (unanswered_count, ratio, etc).
 */

import type { GHLClient } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";

const DEFAULT_LIMIT = 30;

export interface RawMessage {
  direction: "inbound" | "outbound";
  body: string;
  created_at: string;
  source: "ghl" | "sparkbot_web";
}

export interface ContextSignals {
  has_conversation: boolean;
  message_count: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  unanswered_outbound_count: number;
  inbound_count: number;
  outbound_count: number;
  inbound_outbound_ratio: number;
  days_since_last_inbound: number | null;
  messages: RawMessage[];
}

/**
 * Busca contexto da conversa. Retorna mensagens cruas + sinais agregados.
 */
export async function resolveConversationContext(
  ghlClient: GHLClient,
  contactId: string,
  locationId: string,
  options: { limit?: number } = {},
): Promise<ContextSignals> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const all: RawMessage[] = [];

  // 1. GHL conversations (canais externos)
  try {
    const convsResp = await ghlClient.get<{
      conversations?: Array<{ id: string; lastMessageType?: string }>;
    }>("/conversations/search", { locationId, contactId });
    const conversations = convsResp.conversations || [];

    for (const conv of conversations) {
      try {
        const r = await ghlClient.get<{
          messages?: {
            messages?: Array<{ direction: string; body?: string; dateAdded: string }>;
          };
        }>(`/conversations/${conv.id}/messages`, {
          locationId,
          limit: String(limit),
        });
        const msgs = r.messages?.messages || [];
        for (const m of msgs) {
          if (!m.body) continue;
          all.push({
            direction: m.direction === "inbound" ? "inbound" : "outbound",
            body: m.body,
            created_at: m.dateAdded,
            source: "ghl",
          });
        }
      } catch {
        // ignore — uma conv falhou não bloqueia
      }
    }
  } catch {
    // sem GHL conv — segue só com sparkbot
  }

  // 2. sparkbot_messages (web UI)
  try {
    const supabase = createAdminClient();
    const { data: webMsgs } = await supabase
      .from("sparkbot_messages")
      .select("role, content, created_at, channel")
      .eq("active_location_id", locationId)
      .neq("channel", "system")
      .order("created_at", { ascending: false })
      .limit(limit);
    // Filtra apenas mensagens relacionadas a esse contato? sparkbot_messages
    // não tem contact_id direto — então só inclui contexto entre rep e bot.
    // (Optional: skipping web context entirely pra MVP — fonte primária é GHL.)
    void webMsgs;
  } catch {
    // ignore
  }

  // Ordena por timestamp ascendente
  all.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // Sinais
  const inbound = all.filter((m) => m.direction === "inbound");
  const outbound = all.filter((m) => m.direction === "outbound");
  const lastInbound = inbound[inbound.length - 1];
  const lastOutbound = outbound[outbound.length - 1];

  // unanswered: outbound após o último inbound
  const lastInboundTs = lastInbound ? new Date(lastInbound.created_at).getTime() : 0;
  const unanswered = outbound.filter(
    (m) => new Date(m.created_at).getTime() > lastInboundTs,
  ).length;

  const daysSinceLastInbound = lastInbound
    ? Math.floor((Date.now() - new Date(lastInbound.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    has_conversation: all.length > 0,
    message_count: all.length,
    last_inbound_at: lastInbound?.created_at ?? null,
    last_outbound_at: lastOutbound?.created_at ?? null,
    unanswered_outbound_count: unanswered,
    inbound_count: inbound.length,
    outbound_count: outbound.length,
    inbound_outbound_ratio:
      outbound.length > 0 ? inbound.length / outbound.length : 0,
    days_since_last_inbound: daysSinceLastInbound,
    messages: all.slice(-limit), // últimas N pra evitar payload gigante
  };
}
