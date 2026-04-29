/**
 * Auth helper pro Sparkbot Web UI (Custom JS injetado no GHL).
 *
 * Fluxo:
 *   1. Custom JS no GHL extrai userId+locationId+companyId do contexto
 *   2. POST /api/sparkbot/check-admin com esses dados
 *   3. Endpoint valida via GHL API server-to-server (validateGHLUser),
 *      cria/encontra rep_identity correspondente, e retorna JWT temp
 *   4. Custom JS guarda JWT em sessionStorage e usa em todas as chamadas
 *      seguintes (send, inbox, etc)
 *
 * O JWT é separado do SSO normal (cookie spark_session) — usa Authorization
 * header em vez de cookie pra simplificar CORS quando o Custom JS roda no
 * domain do GHL e bate na nossa API.
 *
 * TTL: 1h (curto pra mitigar exposição se Custom JS leakar; refresh trivial).
 */

import { SignJWT, jwtVerify } from "jose";

const SPARKBOT_JWT_TTL_SECONDS = 60 * 60; // 1h

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET não configurado");
  return new TextEncoder().encode(secret);
}

export interface SparkbotWebToken {
  rep_id: string;
  ghl_user_id: string;
  location_id: string;
  company_id: string;
  is_admin: boolean;
  /** epoch ms — emitido em */
  iat: number;
}

export async function signSparkbotWebToken(
  payload: Omit<SparkbotWebToken, "iat">,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SPARKBOT_JWT_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

/**
 * Lê e valida o token do header Authorization. Retorna null se inválido,
 * expirado ou ausente.
 */
export async function verifySparkbotWebToken(
  authHeader: string | null,
): Promise<SparkbotWebToken | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as unknown as SparkbotWebToken;
  } catch {
    return null;
  }
}
