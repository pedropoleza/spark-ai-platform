import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

/**
 * POST /api/agents/test/sessions/:sessionId/messages
 *
 * Adiciona uma mensagem à sessão de teste. Usado principalmente pelo modal
 * de prévia de follow-up — quando o usuário clica "Adicionar à conversa"
 * depois de revisar a mensagem gerada.
 *
 * Body: { role: "agent" | "user", content: string, metadata? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const { sessionId } = await params;
  const body = await request.json();
  const { role, content, metadata } = body;

  if (role !== "agent" && role !== "user") {
    return NextResponse.json({ error: "role inválida (agent|user)" }, { status: 400 });
  }
  if (!content || typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "content obrigatorio" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Valida que a sessão pertence à location do user
  const { data: testSession } = await supabase
    .from("agent_test_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("location_id", session.locationId)
    .maybeSingle();

  if (!testSession) {
    return NextResponse.json({ error: "Sessao nao encontrada" }, { status: 404 });
  }

  const { data: inserted, error } = await supabase
    .from("agent_test_messages")
    .insert({
      session_id: sessionId,
      role,
      content: content.trim(),
      metadata: metadata || {},
    })
    .select("id, role, content, metadata, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: inserted }, { status: 201 });
}
