/**
 * POST /api/agents/ui-auth — auth dos controles do agente injetados na UI do GHL.
 *
 * Diferente do /api/sparkbot/check-admin (que exige ADMIN pro painel SparkBot),
 * aqui basta ser um USER VÁLIDO da location — o rep que atende o lead precisa
 * operar os controles (pausar agente, dar feedback) na tela de contato/conversa.
 *
 * Valida via GHL API (validateGHLUser — confirma que o user pertence à location,
 * fail-closed) e emite o MESMO JWT do painel (signSparkbotWebToken), que os
 * endpoints /contact-status, /contact-pause e /message-feedback verificam.
 *
 * Body: { userId, locationId, companyId }
 * 200: { ok:true, token, rep:{id,name}, isAdmin }
 * 403: { ok:false, reason:"not_a_location_user" }
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-1).
 */
import { NextRequest, NextResponse } from "next/server";
import { validateGHLUser, upsertLocation } from "@/lib/auth/sso";
import { identifyRepByGhlUser } from "@/lib/account-assistant/identity";
import { signSparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";

export const maxDuration = 30;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request, "POST, OPTIONS") });
}

export async function POST(request: NextRequest) {
  const cors = corsHeadersFor(request, "POST, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...cors, ...(init.headers || {}) } });

  try {
    const body = await request.json();
    const userId = String(body.userId || "").trim();
    const locationId = String(body.locationId || "").trim();
    const companyId = String(body.companyId || "").trim();
    if (!userId || !locationId || !companyId) {
      return json({ ok: false, reason: "missing_params" }, { status: 400 });
    }

    try {
      await upsertLocation(locationId, companyId);
    } catch (err) {
      console.warn("[ui-auth] upsertLocation não-fatal:", err instanceof Error ? err.message : err);
    }

    // Confirma que o user pertence à location (fail-closed via GHL API).
    const validation = await validateGHLUser(companyId, locationId, userId);
    if (!validation) {
      return json({ ok: false, reason: "not_a_location_user" }, { status: 403 });
    }

    const rep = await identifyRepByGhlUser({ ghlUserId: userId, locationId, companyId });
    if (!rep) {
      return json({ ok: false, reason: "rep_provision_failed" }, { status: 500 });
    }

    const token = await signSparkbotWebToken({
      rep_id: rep.id,
      ghl_user_id: userId,
      location_id: locationId,
      company_id: companyId,
      is_admin: validation.isAdmin,
    });

    return json({
      ok: true,
      token,
      isAdmin: validation.isAdmin,
      rep: { id: rep.id, name: rep.display_name || "" },
    });
  } catch (err) {
    console.error("[ui-auth] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
