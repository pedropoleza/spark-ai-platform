/**
 * POST /api/agents/ui-auth — auth dos controles do agente injetados na UI do GHL.
 *
 * Diferente do /api/sparkbot/check-admin (que exige ADMIN pro painel SparkBot),
 * aqui basta ser um USER VÁLIDO da location — o rep que atende o lead precisa
 * operar os controles (pausar agente, dar feedback) na tela de contato/conversa.
 *
 * Validação multi-fonte (mesma filosofia do check-admin, sem exigir admin):
 *   1. idToken Firebase (localStorage.refreshedToken) → RS256 via JWKS público.
 *      Caminho CONFIÁVEL pra agency users (que a GHL API não retorna). Aceita
 *      qualquer role/type — só precisa user_id+company_id baterem com o request.
 *   2. Allowlist por env (ASSISTANT_ALLOWED_AGENCY_USERS).
 *   3. GHL API (validateGHLUser) — fallback pra location-level reps.
 *
 * Emite o MESMO JWT do painel (signSparkbotWebToken), que os endpoints
 * /contact-status, /contact-pause e /message-feedback verificam.
 *
 * Body: { userId, locationId, companyId, idToken? }
 * 200: { ok:true, token, rep:{id,name}, isAdmin }
 * 403: { ok:false, reason:"not_a_location_user", debug? }
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-1).
 */
import { NextRequest, NextResponse } from "next/server";
import { validateGHLUser, upsertLocation } from "@/lib/auth/sso";
import { identifyRepByGhlUser } from "@/lib/account-assistant/identity";
import { signSparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { verifyFirebaseIdToken, isAdminClaims } from "@/lib/auth/ghl-idtoken";

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
    const idToken: string | undefined = body.idToken ? String(body.idToken) : undefined;
    if (!userId || !locationId || !companyId) {
      return json({ ok: false, reason: "missing_params" }, { status: 400 });
    }

    try {
      await upsertLocation(locationId, companyId);
    } catch (err) {
      console.warn("[ui-auth] upsertLocation não-fatal:", err instanceof Error ? err.message : err);
    }

    let isValidUser = false;
    let isAdmin = false;
    let source = "";
    let jwtVerifyError: { code?: string; message?: string } | null = null;
    let jwtClaimsMismatch: { jwtUser?: string; jwtCompany?: string } | null = null;

    // 1. idToken Firebase verificado (RS256). Caminho confiável pra agency users.
    // Aqui NÃO exigimos admin — qualquer user real do company com sessão ativa
    // (user_id+company_id batendo) é um operador legítimo dos controles.
    if (idToken) {
      const result = await verifyFirebaseIdToken(idToken);
      if (result.claims) {
        const claims = result.claims;
        if (claims.user_id === userId && claims.company_id === companyId) {
          isValidUser = true;
          isAdmin = isAdminClaims(claims);
          source = `firebase_jwt (role=${claims.role || "?"}, type=${claims.type || "?"})`;
        } else {
          jwtClaimsMismatch = { jwtUser: claims.user_id, jwtCompany: claims.company_id };
        }
      } else {
        jwtVerifyError = { code: result.errorCode, message: result.errorMessage };
      }
    }

    // 2. Allowlist por env (agency users conhecidos).
    if (!isValidUser) {
      const allowlist = (process.env.ASSISTANT_ALLOWED_AGENCY_USERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowlist.includes(`${userId}:${companyId}`)) {
        isValidUser = true;
        isAdmin = true;
        source = "agency_allowlist";
      }
    }

    // 3. Fallback GHL API (location-level reps — o caso comum do rep que atende lead).
    if (!isValidUser) {
      const validation = await validateGHLUser(companyId, locationId, userId);
      if (validation) {
        isValidUser = true;
        isAdmin = validation.isAdmin;
        source = "ghl_api";
      }
    }

    if (!isValidUser) {
      const wantDebug = process.env.NODE_ENV !== "production" || body.debug === true;
      return json(
        {
          ok: false,
          reason: "not_a_location_user",
          ...(wantDebug
            ? { debug: { jwt_verify_error: jwtVerifyError, jwt_claims_mismatch: jwtClaimsMismatch, had_id_token: !!idToken } }
            : {}),
        },
        { status: 403 },
      );
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
      is_admin: isAdmin,
    });
    console.log(`[ui-auth] user OK via ${source} (user=${userId}, admin=${isAdmin})`);

    return json({
      ok: true,
      token,
      isAdmin,
      rep: { id: rep.id, name: rep.display_name || "" },
    });
  } catch (err) {
    console.error("[ui-auth] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
