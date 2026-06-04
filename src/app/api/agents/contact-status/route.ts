/**
 * GET /api/agents/contact-status?contactId=...
 *
 * Diz pro custom JS injetado no GHL se deve mostrar os controles do agente
 * pra esse contato + o estado atual da pausa.
 *
 * Auth: Bearer JWT do /api/agents/ui-auth (location_id vem do token, não do
 * client — fronteira de segurança). contactId vem do query (o contato da tela).
 *
 * 200: { ok:true, hasActiveLeadAgent:bool, agentId?, agentName?, agentType?, paused?, pausedReason? }
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-1).
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { resolveAgentForContact, getContactPauseState } from "@/lib/agents/contact-controls";

export const maxDuration = 20;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request, "GET, OPTIONS") });
}

export async function GET(request: NextRequest) {
  const cors = corsHeadersFor(request, "GET, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...cors, ...(init.headers || {}) } });

  const token = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!token) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const contactId = new URL(request.url).searchParams.get("contactId")?.trim();
  if (!contactId) return json({ ok: false, reason: "missing_contactId" }, { status: 400 });

  try {
    const supabase = createAdminClient();
    const agent = await resolveAgentForContact(supabase, token.location_id, contactId);
    if (!agent) return json({ ok: true, hasActiveLeadAgent: false });

    const pause = await getContactPauseState(supabase, agent.id, contactId);
    return json({
      ok: true,
      hasActiveLeadAgent: true,
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.type,
      paused: pause.paused,
      pausedReason: pause.reason,
    });
  } catch (err) {
    console.error("[contact-status] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
