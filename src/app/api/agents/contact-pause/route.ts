/**
 * POST /api/agents/contact-pause  { contactId, paused, agentId? }
 *
 * Liga/desliga o agente de IA PRA UM CONTATO. Fonte da verdade =
 * conversation_state.ai_paused_at (o runtime já respeita: queue-processor pula
 * quando setado). É o botão standalone da UI do GHL (não depende do campo
 * "AI Status" do GHL, que é específico de 1 conta).
 *
 * Auth: Bearer JWT do /api/agents/ui-auth. location_id e quem-pausou (ghl_user_id)
 * vêm do token. Reason: `manual_ui:user_<ghlUserId>`.
 *
 * Não clobra conversation_id existente: UPDATE-then-INSERT (preserva o link da
 * conversa quando a linha já existe).
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-1).
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { resolveAgentForContact, agentBelongsToLocation } from "@/lib/agents/contact-controls";

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
    const contactId = String(body.contactId || "").trim();
    const paused = body.paused === true;
    const providedAgentId = body.agentId ? String(body.agentId).trim() : null;
    if (!contactId) return json({ ok: false, reason: "missing_contactId" }, { status: 400 });

    const supabase = createAdminClient();
    const locationId = token.location_id;

    // Resolve agente: usa o fornecido (validando que é da location) ou descobre.
    let agentId = providedAgentId;
    if (agentId) {
      const ok = await agentBelongsToLocation(supabase, agentId, locationId);
      if (!ok) return json({ ok: false, reason: "agent_not_in_location" }, { status: 403 });
    } else {
      const agent = await resolveAgentForContact(supabase, locationId, contactId);
      if (!agent) return json({ ok: false, reason: "no_lead_agent" }, { status: 404 });
      agentId = agent.id;
    }

    const nowIso = new Date().toISOString();
    const patch = paused
      ? {
          status: "handed_off",
          ai_paused_at: nowIso,
          ai_paused_reason: `manual_ui:user_${token.ghl_user_id}`,
          updated_at: nowIso,
        }
      : {
          status: "active",
          ai_paused_at: null,
          ai_paused_reason: null,
          updated_at: nowIso,
        };

    // UPDATE primeiro (preserva conversation_id); INSERT só se não existir linha.
    const { data: updated } = await supabase
      .from("conversation_state")
      .update(patch)
      .eq("agent_id", agentId)
      .eq("contact_id", contactId)
      .select("agent_id");

    if (!updated || updated.length === 0) {
      await supabase.from("conversation_state").insert({
        agent_id: agentId,
        location_id: locationId,
        contact_id: contactId,
        conversation_id: "",
        ...patch,
      });
    }

    return json({ ok: true, paused, agentId });
  } catch (err) {
    console.error("[contact-pause] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
