import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

/**
 * GET /api/agents/test/sessions?agent_id=X
 * Lista as sessões de teste do agente, mais recentes primeiro.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  if (!agentId) {
    return NextResponse.json({ error: "agent_id obrigatorio" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Garantir que o agente pertence à location do user
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("location_id", session.locationId)
    .maybeSingle();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  const { data: sessions, error } = await supabase
    .from("agent_test_sessions")
    .select("id, session_name, contact_id, collected_data, created_at, updated_at")
    .eq("agent_id", agentId)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ sessions: sessions || [] });
}

/**
 * POST /api/agents/test/sessions
 * Cria uma nova sessão de teste.
 * Body: { agent_id, session_name?, contact_id? }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const { agent_id, session_name, contact_id } = body;

  if (!agent_id) {
    return NextResponse.json({ error: "agent_id obrigatorio" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agent_id)
    .eq("location_id", session.locationId)
    .maybeSingle();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  const { data: newSession, error } = await supabase
    .from("agent_test_sessions")
    .insert({
      agent_id,
      location_id: session.locationId,
      created_by: session.userId || "unknown",
      session_name: session_name || null,
      contact_id: contact_id || null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ session: newSession }, { status: 201 });
}
