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

    // Validação multi-fonte (em ordem):
    //   1. GHL API (/users/) — sempre tentado primeiro, é a fonte segura
    //   2. JWT do Firebase claims (idToken) — APENAS se SPARKBOT_TRUST_IDTOKEN=1
    //      (default 0 — desabilitado por segurança)
    //
    // Por que idToken trust desabilitado por default (review 2026-04-29 C3):
    //
    // O server decodifica payload do JWT SEM verificar assinatura (Firebase
    // JWKS verify não implementado). Atacante anônimo pode forjar JWT com
    // claims.role:"admin" + claims.type:"agency" e enviar QUALQUER user_id/
    // company_id consistente — o "match check" entre body e claims é
    // tautológico (atacante controla AMBOS os lados).
    //
    // Stress test confirmou: JWT com sig literal "fake-signature-not-verified"
    // foi aceito.
    //
    // Fix correto (P1, sprint 1): implementar verify via Firebase JWKS:
    //   https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
    //
    // Mitigation atual: SPARKBOT_TRUST_IDTOKEN=0 desabilita o branch.
    // GHL API valida via service-to-service token (assinatura Google OAuth).
    // Custo: agency users que não aparecem em /users/?locationId=... voltam
    // a falhar. Pra esses, alternativa: passar via env ASSISTANT_AGENCY_ADMIN_USER_IDS
    // (allowlist de UUIDs) — mas não implementado ainda.
    let isAdmin = false;
    let adminSource = "";

    // 1. Tenta GHL API primeiro (sempre)
    const validation = await validateGHLUser(companyId, locationId, userId);
    if (validation === null) {
      return json({ ok: false, reason: "ghl_validation_failed" }, { status: 502 });
    }
    if (validation.isAdmin) {
      isAdmin = true;
      adminSource = "ghl_api";
    }

    // 2. Fallback idToken — APENAS se feature flag explicitamente liga
    if (!isAdmin && process.env.SPARKBOT_TRUST_IDTOKEN === "1") {
      const idToken: string | undefined = body.idToken ? String(body.idToken) : undefined;
      if (idToken) {
        try {
          const parts = idToken.split(".");
          if (parts.length === 3) {
            const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
            const payload = JSON.parse(
              Buffer.from(payloadB64, "base64").toString("utf-8"),
            ) as {
              claims?: { user_id?: string; company_id?: string; role?: string; type?: string };
              exp?: number;
            };
            const claims = payload.claims || {};
            const matchesUser = claims.user_id === userId;
            const matchesCompany = claims.company_id === companyId;
            const notExpired = !payload.exp || payload.exp * 1000 > Date.now() - 60_000;
            if (matchesUser && matchesCompany && notExpired) {
              const role = (claims.role || "").toLowerCase();
              const type = (claims.type || "").toLowerCase();
              const adminRoles = ["admin", "owner", "agency_owner", "agency_user"];
              const adminTypes = ["admin", "agency", "account"];
              if (adminRoles.includes(role) || adminTypes.includes(type)) {
                isAdmin = true;
                adminSource = `jwt_claims_TRUSTED (role=${role}, type=${type}) — INSEGURO sem JWKS verify`;
                console.warn(
                  "[check-admin] aceitando idToken sem verify de assinatura " +
                  "(SPARKBOT_TRUST_IDTOKEN=1). Implementar JWKS verify ASAP.",
                );
              }
            }
          }
        } catch (e) {
          console.warn("[check-admin] idToken decode falhou:", e instanceof Error ? e.message : e);
        }
      }
    }

    if (!isAdmin) {
      return json({ ok: false, reason: "not_admin" }, { status: 403 });
    }
    console.log(`[check-admin] admin OK via ${adminSource} (user=${userId})`);

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
