import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Retoma a IA de uma conversa de lead pausada: limpa ai_paused_at/
 * ai_paused_reason e volta status pra 'active' (inverso do auto-pause do
 * webhook). Ação iniciada pelo admin, reversível. Usado pela aba "Pausadas"
 * do /hub (feedback Pedro 1c).
 *
 * Anti-IDOR: confere que o agente pertence à location da sessão antes de mexer.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const agentId = String(body.agent_id || "");
  const contactId = String(body.contact_id || "");
  if (!agentId || !contactId) {
    return NextResponse.json({ error: "agent_id e contact_id obrigatórios" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, location_id")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent || agent.location_id !== session.locationId) {
    return NextResponse.json({ error: "Agente não encontrado ou sem acesso" }, { status: 403 });
  }

  const { error } = await supabase
    .from("conversation_state")
    .update({ status: "active", ai_paused_at: null, ai_paused_reason: null, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .eq("location_id", session.locationId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
