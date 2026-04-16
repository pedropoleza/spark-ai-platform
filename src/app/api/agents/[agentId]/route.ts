import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

// GET /api/agents/[agentId]
export async function GET(
  _request: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: agent, error } = await supabase
    .from("agents")
    .select("*, agent_configs(*)")
    .eq("id", params.agentId)
    .eq("location_id", session.locationId)
    .single();

  if (error || !agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  return NextResponse.json({ agent });
}

// PUT /api/agents/[agentId]
export async function PUT(
  request: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const supabase = createServerClient();

  // Whitelist de campos permitidos
  const allowedFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status && ["active", "inactive"].includes(body.status)) allowedFields.status = body.status;
  if (body.name && typeof body.name === "string") allowedFields.name = body.name.substring(0, 255);

  const { data: agent, error } = await supabase
    .from("agents")
    .update(allowedFields)
    .eq("id", params.agentId)
    .eq("location_id", session.locationId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Ao ATIVAR: limpar pausas de conversas para que o agente volte a
  // responder contatos que estavam pausados antes da desativacao.
  if (body.status === "active") {
    await supabase
      .from("conversation_state")
      .update({ ai_paused_at: null, ai_paused_reason: null, status: "active" })
      .eq("agent_id", params.agentId)
      .not("ai_paused_at", "is", null);
  }

  return NextResponse.json({ agent });
}

// DELETE /api/agents/[agentId]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { error } = await supabase
    .from("agents")
    .delete()
    .eq("id", params.agentId)
    .eq("location_id", session.locationId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
