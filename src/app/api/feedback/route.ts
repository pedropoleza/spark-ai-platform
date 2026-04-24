import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { createFeedbackSchema, updateFeedbackSchema, validateBody } from "@/lib/utils/validation";
import { errorResponse, unauthorized } from "@/lib/utils/api";

// POST /api/feedback — salvar feedback
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json();
  const { data: validated, error: validationError } = validateBody(createFeedbackSchema, body);
  if (validationError || !validated) {
    return errorResponse(validationError || "Dados inválidos", 400, "invalid_body");
  }

  const supabase = createServerClient();

  const { error } = await supabase.from("agent_feedback").insert({
    agent_id: validated.agent_id,
    location_id: session.locationId,
    rating: validated.rating,
    ai_message: validated.ai_message,
    user_message: validated.user_message || null,
    suggestion: validated.suggestion || null,
    context: validated.context || null,
  });

  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({ success: true });
}

// GET /api/feedback?agent_id=xxx — buscar feedbacks para o prompt
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const agentId = request.nextUrl.searchParams.get("agent_id");
  if (!agentId) return errorResponse("agent_id obrigatório", 400, "missing_param");

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

// DELETE /api/feedback?id=xxx — apagar feedback
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const id = request.nextUrl.searchParams.get("id");
  const agentId = request.nextUrl.searchParams.get("agent_id");
  if (!id || !agentId) return errorResponse("id e agent_id obrigatórios", 400, "missing_param");

  const supabase = createServerClient();
  const { error } = await supabase
    .from("agent_feedback")
    .delete()
    .eq("id", id)
    .eq("agent_id", agentId)
    .eq("location_id", session.locationId);

  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({ success: true });
}

// PATCH /api/feedback — editar feedback existente (rating/suggestion)
export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json();
  const { data: validated, error: validationError } = validateBody(updateFeedbackSchema, body);
  if (validationError || !validated) {
    return errorResponse(validationError || "Dados inválidos", 400, "invalid_body");
  }

  const update: Record<string, unknown> = {};
  if (validated.rating) update.rating = validated.rating;
  if (validated.suggestion !== undefined) update.suggestion = validated.suggestion || null;

  if (Object.keys(update).length === 0) {
    return errorResponse("Nenhum campo para atualizar", 400, "nothing_to_update");
  }

  const supabase = createServerClient();
  const { error } = await supabase
    .from("agent_feedback")
    .update(update)
    .eq("id", validated.id)
    .eq("agent_id", validated.agent_id)
    .eq("location_id", session.locationId);

  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({ success: true });
}
