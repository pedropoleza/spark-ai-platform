/**
 * POST /api/sparkbot/check-admin
 *
 * Endpoint chamado pelo loader.js (Custom JS no GHL) pra:
 *   1. Validar que o user_id do GHL é admin (location ou agency)
 *   2. Encontrar/criar rep_identity correspondente
 *   3. Emitir JWT temporário (1h) que o painel web usa em chamadas seguintes
 *
 * Body: { userId: string, locationId: string, companyId: string }
 * Resposta sucesso (200):
 *   { ok: true, token: string, rep: { id, name, terms_accepted } }
 * Resposta não-admin (403):
 *   { ok: false, reason: "not_admin" }
 *
 * CORS: liberado pra qualquer origin GHL (app.gohighlevel.com, app.sparkleads.pro,
 * domínios white-label do agency). Em produção, restringir lista se quisermos.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateGHLUser, upsertLocation } from "@/lib/auth/sso";
import { identifyRepByGhlUser, acceptTerms } from "@/lib/account-assistant/identity";
import { signSparkbotWebToken } from "@/lib/account-assistant/web-auth";

export const maxDuration = 30;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...CORS_HEADERS, ...(init.headers || {}) } });

  try {
    const body = await request.json();
    const userId: string = String(body.userId || "").trim();
    const locationId: string = String(body.locationId || "").trim();
    const companyId: string = String(body.companyId || "").trim();
    const locationName: string | undefined = body.locationName ? String(body.locationName) : undefined;
    const timezone: string | undefined = body.timezone ? String(body.timezone) : undefined;

    if (!userId || !locationId || !companyId) {
      return json({ ok: false, reason: "missing_params" }, { status: 400 });
    }

    // Garante que a location existe (pra Sparkbot poder operar nela)
    try {
      await upsertLocation(locationId, companyId, locationName, timezone);
    } catch (err) {
      // Não bloqueia — location já pode existir; valida via GHL ainda
      console.warn("[check-admin] upsertLocation falhou (não-fatal):", err instanceof Error ? err.message : err);
    }

    // Valida via GHL API. validateGHLUser retorna o user com role+type;
    // isAdmin já considera 'admin', 'owner', 'agency_owner', 'agency_user',
    // 'account', 'admin', 'agency'.
    const validation = await validateGHLUser(companyId, locationId, userId);
    if (!validation) {
      return json({ ok: false, reason: "ghl_validation_failed" }, { status: 502 });
    }
    if (!validation.isAdmin) {
      return json({ ok: false, reason: "not_admin" }, { status: 403 });
    }

    // Encontra ou cria rep_identity. Se rep não tem phone cadastrado,
    // ainda funciona (web-only). Quando rep usar WhatsApp depois com phone
    // real, esse rep vai ser unificado por phone.
    const rep = await identifyRepByGhlUser({ ghlUserId: userId, locationId, companyId });
    if (!rep) {
      return json({ ok: false, reason: "rep_provision_failed" }, { status: 500 });
    }

    // Auto-accept terms pra usuários que abrem via web pela primeira vez —
    // o GHL admin já aceitou termos do produto na onboarding do agency.
    // (Em WhatsApp pedimos explicitamente porque é primeira interação fora
    // do app; no app GHL é UX redundante.)
    if (!rep.terms_accepted_at) {
      await acceptTerms(rep.id);
    }

    // Emite JWT temporário (1h) — Custom JS guarda em sessionStorage
    const token = await signSparkbotWebToken({
      rep_id: rep.id,
      ghl_user_id: userId,
      location_id: locationId,
      company_id: companyId,
      is_admin: true,
    });

    return json({
      ok: true,
      token,
      rep: {
        id: rep.id,
        name: rep.display_name || "",
        terms_accepted: true,
        active_location_id: rep.active_location_id || locationId,
      },
    });
  } catch (err) {
    console.error("[check-admin] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
