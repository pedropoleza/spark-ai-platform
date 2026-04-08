import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

// POST /api/feedback — salvar feedback
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const { agent_id, rating, ai_message, user_message, suggestion, context } = body;

  if (!agent_id || !rating || !ai_message) {
    return NextResponse.json({ error: "Campos obrigatorios faltando" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { error } = await supabase.from("agent_feedback").insert({
    agent_id,
    location_id: session.locationId,
    rating,
    ai_message,
    user_message: user_message || null,
    suggestion: suggestion || null,
    context: context || null,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

// GET /api/feedback?agent_id=xxx — buscar feedbacks para o prompt
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const agentId = request.nextUrl.searchParams.get("agent_id");
  if (!agentId) {
    return NextResponse.json({ error: "agent_id obrigatorio" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data } = await supabase
    .from("agent_feedback")
    .select("*")
    .eq("agent_id", agentId)
    .eq("location_id", session.locationId)
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ feedback: data || [] });
}
