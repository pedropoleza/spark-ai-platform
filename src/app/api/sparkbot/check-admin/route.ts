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
import { importJWK, jwtVerify, type JWK } from "jose";

export const maxDuration = 30;

// O JWT do GHL/sparkleads é assinado pelo SERVICE ACCOUNT custom do GHL
// (default-crm-marketplace@highlevel-backend.iam.gserviceaccount.com).
// O JWKS público fica em /robot/v1/metadata/jwk/.
//
// Tokens não têm `kid` no header, e o JWKS tem múltiplas keys (rotação).
// jose.createRemoteJWKSet falha com ERR_JWKS_MULTIPLE_MATCHING_KEYS — então
// fazemos seleção manual: cache JWKS por 1h, tentar cada key até validar.
const GHL_SERVICE_ACCOUNT_EMAIL = "default-crm-marketplace@highlevel-backend.iam.gserviceaccount.com";
const GHL_JWKS_URL = `https://www.googleapis.com/robot/v1/metadata/jwk/${GHL_SERVICE_ACCOUNT_EMAIL}`;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface JwksCacheEntry {
  keys: JWK[];
  fetchedAt: number;
}
let jwksCache: JwksCacheEntry | null = null;

async function fetchJwks(): Promise<JWK[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(GHL_JWKS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
  const data = await res.json() as { keys: JWK[] };
  jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

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
interface VerifyResult {
  claims: FirebaseClaims | null;
  errorCode?: string;
  errorMessage?: string;
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifyResult> {
  // Tolerância: localStorage GHL/sparkleads pode ter o JWT JSON-stringified
  // (com aspas extras). Strip antes de passar pro jose.
  let token = idToken.trim();
  if (token.startsWith('"') && token.endsWith('"')) {
    try { token = JSON.parse(token) as string; } catch { /* deixa como tava */ }
  }

  let keys: JWK[];
  try {
    keys = await fetchJwks();
  } catch (err) {
    return { claims: null, errorCode: "jwks_fetch_failed", errorMessage: String(err) };
  }
  if (keys.length === 0) {
    return { claims: null, errorCode: "jwks_empty", errorMessage: "no keys" };
  }

  // Tenta cada key — primeira que valida ganha.
  let lastError: { code?: string; message?: string } | null = null;
  for (const jwk of keys) {
    try {
      const key = await importJWK(jwk, jwk.alg || "RS256");
      const { payload } = await jwtVerify(token, key, {
        issuer: GHL_SERVICE_ACCOUNT_EMAIL,
      });
      const claims = (payload as { claims?: FirebaseClaims }).claims;
      return { claims: claims || null };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      lastError = { code: e.code, message: e.message };
      // Continua tentando próxima key (signature errada = essa key não bate)
    }
  }

  console.warn(
    `[check-admin] GHL idToken verify falhou em todas ${keys.length} keys: `
    + `code=${lastError?.code || "?"} msg=${lastError?.message || "?"}`,
  );
  return {
    claims: null,
    errorCode: lastError?.code || "verify_failed_all_keys",
    errorMessage: lastError?.message || `tried ${keys.length} keys`,
  };
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
    let jwtVerifyError: { code?: string; message?: string } | null = null;
    let jwtClaimsMismatch: { jwtUser?: string; jwtCompany?: string } | null = null;

    // 1. Tenta verificar idToken Firebase (assinatura RS256)
    const idToken: string | undefined = body.idToken ? String(body.idToken) : undefined;
    if (idToken) {
      const result = await verifyFirebaseIdToken(idToken);
      if (result.claims) {
        const claims = result.claims;
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
          jwtClaimsMismatch = { jwtUser: claims.user_id, jwtCompany: claims.company_id };
          console.warn(
            "[check-admin] Firebase JWT VERIFICADO mas claims não batem com body",
            { jwtUser: claims.user_id, bodyUser: userId, jwtCompany: claims.company_id, bodyCompany: companyId },
          );
        }
      } else {
        jwtVerifyError = { code: result.errorCode, message: result.errorMessage };
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
      // Debug exposto em dev OU se body.debug=true (op auto-diagnostic).
      const wantDebug = process.env.NODE_ENV !== "production" || body.debug === true;
      if (wantDebug) {
        return json({
          ok: false,
          reason: "not_admin",
          debug: {
            jwt_verify_error: jwtVerifyError,
            jwt_claims_mismatch: jwtClaimsMismatch,
            had_id_token: !!idToken,
          },
        }, { status: 403 });
      }
      void jwtVerifyError;
      void jwtClaimsMismatch;
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
