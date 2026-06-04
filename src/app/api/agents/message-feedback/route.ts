/**
 * POST /api/agents/message-feedback
 *   { agentId, contactId, aiMessage, rating: 'positive'|'negative', suggestion?, userMessage? }
 *
 * Grava feedback do rep sobre uma mensagem do agente, na tabela agent_feedback
 * — que JÁ é carregada no prompt (sales-prompt-builder, seção feedback). Loop
 * fecha sozinho: 👎 + "preferia assim" → entra no prompt → agente corrige.
 *
 * Auth: Bearer JWT do /api/agents/ui-auth (location_id do token). agentId é
 * validado contra a location.
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-1).
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { agentBelongsToLocation } from "@/lib/agents/contact-controls";

export const maxDuration = 20;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request, "POST, OPTIONS") });
}

export async function POST(request: NextRequest) {
  const cors = corsHeadersFor(request, "POST, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...cors, ...(init.headers || {}) } });

  const token = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!token) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const agentId = String(body.agentId || "").trim();
    const contactId = String(body.contactId || "").trim();
    const aiMessage = String(body.aiMessage || "").trim();
    const rating = String(body.rating || "").trim().toLowerCase();
    const suggestion = body.suggestion ? String(body.suggestion).trim() : null;
    const userMessage = body.userMessage ? String(body.userMessage).trim() : null;

    if (!agentId || !aiMessage) {
      return json({ ok: false, reason: "missing_params" }, { status: 400 });
    }
    if (rating !== "positive" && rating !== "negative") {
      return json({ ok: false, reason: "invalid_rating" }, { status: 400 });
    }

    const supabase = createAdminClient();
    const belongs = await agentBelongsToLocation(supabase, agentId, token.location_id);
    if (!belongs) return json({ ok: false, reason: "agent_not_in_location" }, { status: 403 });

    const { error } = await supabase.from("agent_feedback").insert({
      agent_id: agentId,
      location_id: token.location_id,
      rating,
      ai_message: aiMessage.slice(0, 4000),
      user_message: userMessage ? userMessage.slice(0, 4000) : null,
      suggestion: suggestion ? suggestion.slice(0, 4000) : null,
      // context: pista pro analytics de onde veio o feedback + qual contato.
      context: JSON.stringify({ source: "ghl_ui", contact_id: contactId || null, by: token.ghl_user_id }),
    });
    if (error) {
      console.error("[message-feedback] insert error:", error.message);
      return json({ ok: false, reason: "insert_failed" }, { status: 500 });
    }

    return json({ ok: true });
  } catch (err) {
    console.error("[message-feedback] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
