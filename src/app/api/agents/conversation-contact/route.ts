/**
 * GET /api/agents/conversation-contact?conversationId=...
 *
 * Mapeia conversationId → contactId (GU-4). Na tela de Conversations do GHL a URL
 * só tem o conversationId; os controles do agente (pill, feedback) precisam do
 * contactId. Resolve via GHL API /conversations/{id}.
 *
 * Auth: Bearer JWT do /api/agents/ui-auth (location_id + company_id do token).
 *
 * 200: { ok:true, contactId } | { ok:true, contactId:null } se não achou.
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-4).
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { GHLClient } from "@/lib/ghl/client";

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

  const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim();
  if (!conversationId) return json({ ok: false, reason: "missing_conversationId" }, { status: 400 });

  try {
    const ghlClient = new GHLClient(token.company_id, token.location_id);
    const resp = await ghlClient
      .get<{ conversation?: { contactId?: string }; contactId?: string }>(
        `/conversations/${conversationId}`,
        { locationId: token.location_id },
      )
      .catch(() => null);
    const contactId = resp?.conversation?.contactId || resp?.contactId || null;
    return json({ ok: true, contactId });
  } catch (err) {
    console.error("[conversation-contact] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
