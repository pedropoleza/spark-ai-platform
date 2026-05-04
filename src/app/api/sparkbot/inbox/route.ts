/**
 * Endpoints de inbox/heartbeat do Sparkbot Web.
 *
 * GET    /api/sparkbot/inbox         → últimas msgs do agente + flag is_read.
 *                                       Atualiza heartbeat web.
 * POST   /api/sparkbot/inbox/read    → marca msgs como lidas (rep abriu painel)
 *
 * Auth: Bearer JWT do /check-admin.
 *
 * Heartbeat: cada GET atualiza rep_identities.web_session_active_at.
 * Reminder runner usa esse timestamp pra decidir entre WhatsApp/Web no
 * canal 'auto'.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";

export const maxDuration = 30;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request) });
}

/** Helper local: retorna JSON com headers CORS aplicados pra esse request. */
function makeJsonResponder(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request);
  return (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, {
      ...init,
      headers: { ...corsHeaders, ...(init.headers || {}) },
    });
}

/**
 * GET — retorna últimas N msgs (default 50) + count de não-lidas + heartbeat.
 *
 * Query params:
 *   - limit: 1-200, default 50
 *   - since: ISO timestamp, default null (todas)
 *   - only_unread: '1' = só msgs do agente não-lidas (proativas pendentes)
 */
export async function GET(request: NextRequest) {
  const json = makeJsonResponder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 200);
  const since = url.searchParams.get("since");
  const onlyUnread = url.searchParams.get("only_unread") === "1";

  const supabase = createAdminClient();

  // Heartbeat fire-and-forget: atualiza web_session_active_at. Reminder
  // runner consulta isso pra decidir 'auto' channel.
  void supabase
    .from("rep_identities")
    .update({ web_session_active_at: new Date().toISOString() })
    .eq("id", tok.rep_id);

  // Busca msgs
  let query = supabase
    .from("sparkbot_messages")
    .select("id, role, content, channel, created_at, read_in_web_at, metadata")
    .eq("rep_id", tok.rep_id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (since) query = query.gt("created_at", since);
  if (onlyUnread) {
    query = query.eq("role", "agent").is("read_in_web_at", null);
  }

  const { data, error } = await query;
  if (error) {
    return json({ ok: false, reason: error.message }, { status: 500 });
  }

  // Reverte pra ordem cronológica pra renderizar
  const messages = (data || []).reverse().map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    channel: m.channel || "whatsapp",
    created_at: m.created_at,
    is_read: !!m.read_in_web_at,
    is_proactive: m.role === "agent" && !m.read_in_web_at && m.channel !== "web_ui",
    metadata: m.metadata || {},
  }));

  // Conta não-lidas (msgs do agente que ainda não foram vistas no web)
  const { count: unreadCount } = await supabase
    .from("sparkbot_messages")
    .select("id", { count: "exact", head: true })
    .eq("rep_id", tok.rep_id)
    .eq("role", "agent")
    .is("read_in_web_at", null);

  return json({
    ok: true,
    messages,
    unread_count: unreadCount || 0,
  });
}

/**
 * POST — marca msgs como lidas. Body: { message_ids: string[] }
 * Se message_ids vazio/ausente, marca TODAS as não-lidas.
 */
export async function POST(request: NextRequest) {
  const json = makeJsonResponder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const messageIds: string[] = Array.isArray(body.message_ids) ? body.message_ids : [];

  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  let query = supabase
    .from("sparkbot_messages")
    .update({ read_in_web_at: nowIso })
    .eq("rep_id", tok.rep_id) // segurança: só marca msgs do próprio rep
    .eq("role", "agent")
    .is("read_in_web_at", null);

  if (messageIds.length > 0) {
    query = query.in("id", messageIds);
  }

  const { error } = await query.select("id");
  if (error) {
    return json({ ok: false, reason: error.message }, { status: 500 });
  }

  return json({ ok: true, marked_read_at: nowIso });
}
