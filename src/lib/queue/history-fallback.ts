import { createAdminClient } from "@/lib/supabase/admin";
import type { ConversationTurn } from "@/lib/ai/openai-client";

/**
 * reconstructHistoryFromDb (Fix bug observado em prod 2026-06-04): rede de
 * segurança contra "cold-start" do agente lead-facing.
 *
 * Causa do bug: quando o fetch de histórico do Spark Leads
 * (`/conversations/{id}/messages`) falha ou volta VAZIO no meio de uma conversa,
 * o queue-processor seguia com `conversationTurns=[]` e a IA re-apresentava do
 * zero ("Oi! Sou Assistente... já tenho seus dados aqui") — esquecendo que já
 * tinha qualificado o lead e estava marcando ligação. Caso: contato "Pedro teste
 * IA" às 17:15 — o prompt caiu de 13k pra 8k tokens (o histórico sumiu) e o lead
 * que mandou só "Oi ta ai?" recebeu uma re-apresentação completa.
 *
 * Fonte de verdade ALTERNATIVA (nosso próprio DB, independente do Spark Leads):
 *   - inbound do lead → `message_queue` (onde os webhooks aterrissam)
 *   - envios da IA    → `execution_log` (action_type=send_message, success=true)
 * Merge + ordenação cronológica + `slice(-limit)`. Não inclui outbound de humano
 * (não temos no DB), mas pra conversa conduzida pela IA é suficiente e
 * infinitamente melhor que histórico vazio.
 */
export async function reconstructHistoryFromDb(params: {
  supabase: ReturnType<typeof createAdminClient>;
  locationId: string;
  contactId: string;
  limit?: number;
}): Promise<ConversationTurn[]> {
  const { supabase, locationId, contactId, limit = 30 } = params;

  // Busca em paralelo: últimos N inbounds do lead + últimos N envios da IA.
  // Fetch desc + limit em cada um pra pegar os mais recentes; o merge/slice
  // abaixo reduz pro tail cronológico final.
  const [inboundRes, outboundRes] = await Promise.all([
    supabase
      .from("message_queue")
      .select("message_body, received_at")
      .eq("location_id", locationId)
      .eq("contact_id", contactId)
      .eq("message_direction", "inbound")
      .order("received_at", { ascending: false })
      .limit(limit),
    supabase
      .from("execution_log")
      .select("action_payload, created_at")
      .eq("location_id", locationId)
      .eq("contact_id", contactId)
      .eq("action_type", "send_message")
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  type Row = { ts: number; turn: ConversationTurn };
  const rows: Row[] = [];

  for (const m of inboundRes.data || []) {
    const body = ((m as { message_body?: string }).message_body || "").trim();
    const ts = new Date((m as { received_at?: string }).received_at || 0).getTime();
    if (!body || !Number.isFinite(ts)) continue;
    rows.push({ ts, turn: { role: "user", content: body.substring(0, 500) } });
  }

  for (const e of outboundRes.data || []) {
    const text = extractSendMessageText((e as { action_payload?: unknown }).action_payload);
    const ts = new Date((e as { created_at?: string }).created_at || 0).getTime();
    if (!text || !Number.isFinite(ts)) continue;
    rows.push({ ts, turn: { role: "assistant", content: text.substring(0, 500) } });
  }

  // Ordena cronológico (asc) e fica com os últimos `limit` turns reais.
  rows.sort((a, b) => a.ts - b.ts);
  return rows.slice(-limit).map((r) => r.turn);
}

/**
 * Extrai o texto de um payload de send_message. O `action_payload.message` pode
 * vir como array (multi-bubble) OU string. Normaliza pra string única.
 */
function extractSendMessageText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const msg = (payload as { message?: unknown }).message;
  if (Array.isArray(msg)) {
    return msg
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .join("\n\n")
      .trim();
  }
  if (typeof msg === "string") return msg.trim();
  return "";
}
