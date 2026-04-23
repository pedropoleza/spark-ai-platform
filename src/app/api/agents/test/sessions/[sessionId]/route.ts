import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

/**
 * GET /api/agents/test/sessions/:sessionId
 * Retorna detalhe da sessão + todas as mensagens em ordem cronológica.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const { sessionId } = await params;
  const supabase = createServerClient();

  const { data: testSession } = await supabase
    .from("agent_test_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("location_id", session.locationId)
    .maybeSingle();

  if (!testSession) {
    return NextResponse.json({ error: "Sessao nao encontrada" }, { status: 404 });
  }

  const { data: messages } = await supabase
    .from("agent_test_messages")
    .select("id, role, content, metadata, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    session: testSession,
    messages: messages || [],
  });
}

/**
 * DELETE /api/agents/test/sessions/:sessionId
 * Apaga a sessão (cascade apaga as mensagens).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const { sessionId } = await params;
  const supabase = createServerClient();

  const { error } = await supabase
    .from("agent_test_sessions")
    .delete()
    .eq("id", sessionId)
    .eq("location_id", session.locationId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
