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
import { createRemoteJWKSet, jwtVerify } from "jose";

export const maxDuration = 30;

// O JWT do GHL/sparkleads é assinado pelo SERVICE ACCOUNT custom do GHL
// (default-crm-marketplace@highlevel-backend.iam.gserviceaccount.com), não
// pelas chaves do securetoken@system padrão do Firebase. JWKS do service
// account fica em endpoint específico — Google publica as public keys lá.
//
// Header desses tokens não tem `kid` claim, então jose vai testar todas
// as keys do JWKS até achar a que valida (single key na maioria das vezes).
const GHL_SERVICE_ACCOUNT_EMAIL = "default-crm-marketplace@highlevel-backend.iam.gserviceaccount.com";
const GHL_JWKS = createRemoteJWKSet(
  new URL(`https://www.googleapis.com/robot/v1/metadata/jwk/${GHL_SERVICE_ACCOUNT_EMAIL}`),
);

interface FirebaseClaims {
  user_id?: string;
  company_id?: string;
  role?: string;
  type?: string;
  locations?: string[];
}

/**
 * Verifica idToken do GHL via Firebase JWKS.
 * Retorna claims se válido (assinatura + exp + iss), null caso contrário.
 *
 * Nota: aud claim do GHL aponta pra "https://identitytoolkit.googleapis.com/..."
 * (não pro nosso projeto Firebase). Isso é normal — o JWT é da própria
 * Identity Toolkit do Firebase do GHL. Verificamos só assinatura + exp + iss
 * (=securetoken.google.com).
 */
async function verifyFirebaseIdToken(idToken: string): Promise<FirebaseClaims | null> {
  // Tolerância: localStorage GHL/sparkleads pode ter o JWT JSON-stringified
  // (com aspas extras). Strip antes de passar pro jose.
  let token = idToken.trim();
  if (token.startsWith('"') && token.endsWith('"')) {
    try { token = JSON.parse(token) as string; } catch { /* deixa como tava */ }
  }

  try {
    const { payload } = await jwtVerify(token, GHL_JWKS, {
      issuer: GHL_SERVICE_ACCOUNT_EMAIL,
      // Audience é Identity Toolkit do GHL — não validamos.
    });
    const claims = (payload as { claims?: FirebaseClaims }).claims;
    return claims || null;
  } catch (err) {
    console.warn(
      "[check-admin] GHL idToken verify falhou:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

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
    //   1. idToken Firebase (JWT do GHL/sparkleads localStorage.refreshedToken)
    //      → verificado RS256 contra Firebase JWKS público. Assinatura
    //      válida = JWT emitido pelo Identity Toolkit pra um user REAL do
    //      Firebase Auth do GHL. Claims confiáveis (role, type, etc).
    //   2. GHL API (/users/?locationId=...) — fallback pra users
    //      location-level que não estão como agency-admin.
    //
    // Histórico (review 2026-04-29 C3):
    // Versão anterior decodificava idToken sem verify → atacante anônimo
    // forjava JWT com claims arbitrários. Stress test confirmou exploit.
    // Fix definitivo: jose.jwtVerify contra
    //   https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
    let isAdmin = false;
    let adminSource = "";

    // 1. Tenta verificar idToken Firebase (assinatura RS256)
    const idToken: string | undefined = body.idToken ? String(body.idToken) : undefined;
    if (idToken) {
      const claims = await verifyFirebaseIdToken(idToken);
      if (claims) {
        // Verify de consistência (defesa contra replay-com-userId-trocado):
        // claims do JWT autêntico têm que bater com userId/companyId do body
        const matchesUser = claims.user_id === userId;
        const matchesCompany = claims.company_id === companyId;
        if (matchesUser && matchesCompany) {
          const role = (claims.role || "").toLowerCase();
          const type = (claims.type || "").toLowerCase();
          const adminRoles = ["admin", "owner", "agency_owner", "agency_user"];
          const adminTypes = ["admin", "agency", "account"];
          if (adminRoles.includes(role) || adminTypes.includes(type)) {
            isAdmin = true;
            adminSource = `firebase_jwt (role=${role}, type=${type})`;
          }
        } else {
          console.warn(
            "[check-admin] Firebase JWT VERIFICADO mas claims user/company não batem com body — possível CSRF",
            { jwtUser: claims.user_id, bodyUser: userId, jwtCompany: claims.company_id, bodyCompany: companyId },
          );
        }
      }
    }

    // 2. Fallback GHL API (location-level admins)
    if (!isAdmin) {
      const validation = await validateGHLUser(companyId, locationId, userId);
      if (validation === null) {
        return json({ ok: false, reason: "ghl_validation_failed" }, { status: 502 });
      }
      if (validation.isAdmin) {
        isAdmin = true;
        adminSource = "ghl_api";
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
