/**
 * Verificação do idToken Firebase do GHL/Spark Leads (RS256 via JWKS público).
 *
 * Fonte única (extraído de check-admin em 2026-06-04 pra reuso no ui-auth dos
 * controles de UI). Quando o GHL embute o user numa sessão, o localStorage
 * guarda um `refreshedToken` assinado pelo Identity Toolkit do Firebase do GHL.
 * Verificar a ASSINATURA RS256 desse JWT é o caminho CONFIÁVEL pra autenticar
 * agency users (que a GHL API `/users/?locationId=` NÃO retorna).
 *
 * Histórico de segurança (review 2026-04-29 C3): versão anterior decodificava o
 * idToken SEM verificar assinatura → atacante anônimo forjava claims arbitrários
 * (exploit confirmado em stress test). Fix definitivo = jwtVerify contra o JWKS
 * público do issuer. NÃO afrouxar isso.
 */
import { importJWK, jwtVerify, type JWK } from "jose";

// O JWT do GHL/sparkleads é assinado por SERVICE ACCOUNTS custom do GHL.
// O backend deles rotaciona entre múltiplos service accounts (vimos
// 'default-crm-marketplace' e 'default-platform' em produção). Cada um
// tem seu JWKS endpoint próprio em /robot/v1/metadata/jwk/.
//
// Estratégia:
// - Aceita lista de issuers conhecidos do GHL
// - Pra verify: lê iss do token, busca JWKS correspondente, tenta cada key
// - Se SIGNATURE_FAILED em todas, force-refresh JWKS e tenta de novo
// - Tokens não têm `kid`, então iteração manual ao invés de createRemoteJWKSet
const GHL_KNOWN_ISSUERS = [
  "default-crm-marketplace@highlevel-backend.iam.gserviceaccount.com",
  "default-platform@highlevel-backend.iam.gserviceaccount.com",
];
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface JwksCacheEntry {
  keys: JWK[];
  fetchedAt: number;
}
const jwksCacheByIssuer = new Map<string, JwksCacheEntry>();

async function fetchJwks(issuer: string, force = false): Promise<JWK[]> {
  const cached = jwksCacheByIssuer.get(issuer);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }
  const url = `https://www.googleapis.com/robot/v1/metadata/jwk/${issuer}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`JWKS fetch ${issuer} ${res.status}`);
  const data = (await res.json()) as { keys: JWK[] };
  jwksCacheByIssuer.set(issuer, { keys: data.keys || [], fetchedAt: Date.now() });
  return data.keys || [];
}

/** Lê iss do JWT sem verificar assinatura (pra escolher JWKS correto). */
function peekIssuer(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b + "=".repeat((4 - (b.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as { iss?: string };
    return payload.iss || null;
  } catch {
    return null;
  }
}

export interface FirebaseClaims {
  user_id?: string;
  company_id?: string;
  role?: string;
  type?: string;
  locations?: string[];
}

export interface VerifyResult {
  claims: FirebaseClaims | null;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Verifica idToken do GHL via Firebase JWKS.
 * Retorna claims se válido (assinatura + exp + iss), null caso contrário.
 *
 * Nota: aud claim do GHL aponta pra "https://identitytoolkit.googleapis.com/..."
 * (não pro nosso projeto Firebase). Isso é normal — o JWT é da própria
 * Identity Toolkit do Firebase do GHL. Verificamos só assinatura + exp + iss.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<VerifyResult> {
  // Tolerância: localStorage GHL/sparkleads pode ter o JWT JSON-stringified
  // (com aspas extras). Strip antes de passar pro jose.
  let token = idToken.trim();
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      token = JSON.parse(token) as string;
    } catch {
      /* deixa como tava */
    }
  }

  // Lê iss do token pra escolher JWKS correto. Se iss for unknown, rejeita.
  const peekedIssuer = peekIssuer(token);
  if (!peekedIssuer) {
    return { claims: null, errorCode: "missing_iss", errorMessage: "JWT sem iss claim" };
  }
  if (!GHL_KNOWN_ISSUERS.includes(peekedIssuer)) {
    return {
      claims: null,
      errorCode: "unknown_iss",
      errorMessage: `iss não é GHL known: ${peekedIssuer}`,
    };
  }
  const issuer: string = peekedIssuer;

  // Helper: tenta cada key do set
  async function tryKeys(
    keys: JWK[],
  ): Promise<{ claims: FirebaseClaims | null; lastError: { code?: string; message?: string } | null }> {
    let lastError: { code?: string; message?: string } | null = null;
    for (const jwk of keys) {
      try {
        const key = await importJWK(jwk, jwk.alg || "RS256");
        const { payload } = await jwtVerify(token, key, { issuer });
        const claims = (payload as { claims?: FirebaseClaims }).claims;
        return { claims: claims || null, lastError: null };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        lastError = { code: e.code, message: e.message };
      }
    }
    return { claims: null, lastError };
  }

  // 1ª tentativa com cache
  let keys: JWK[];
  try {
    keys = await fetchJwks(issuer);
  } catch (err) {
    return { claims: null, errorCode: "jwks_fetch_failed", errorMessage: String(err) };
  }
  if (keys.length === 0) {
    return { claims: null, errorCode: "jwks_empty", errorMessage: `no keys for ${issuer}` };
  }

  let result = await tryKeys(keys);
  if (result.claims) return { claims: result.claims };

  // SIGNATURE_FAILED em todas → JWKS pode ter rotacionado. Force-refresh.
  if (result.lastError?.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
    console.warn(`[ghl-idtoken] ${issuer} keys cacheadas falharam — force-refresh`);
    try {
      keys = await fetchJwks(issuer, true);
      result = await tryKeys(keys);
      if (result.claims) return { claims: result.claims };
    } catch (err) {
      console.warn("[ghl-idtoken] JWKS force-refresh falhou:", err instanceof Error ? err.message : err);
    }
  }

  console.warn(
    `[ghl-idtoken] verify falhou em todas ${keys.length} keys de ${issuer}: ` +
      `code=${result.lastError?.code || "?"} msg=${result.lastError?.message || "?"}`,
  );
  return {
    claims: null,
    errorCode: result.lastError?.code || "verify_failed",
    errorMessage: result.lastError?.message || `tried ${keys.length} keys`,
  };
}

/** Classifica claims verificados como admin (role/type de agency/admin/owner). */
export function isAdminClaims(claims: FirebaseClaims): boolean {
  const role = (claims.role || "").toLowerCase();
  const type = (claims.type || "").toLowerCase();
  const adminRoles = ["admin", "owner", "agency_owner", "agency_user"];
  const adminTypes = ["admin", "agency", "account"];
  return adminRoles.includes(role) || adminTypes.includes(type);
}
