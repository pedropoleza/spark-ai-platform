/**
 * GHL Token Refresher (Pedro 2026-05-17).
 *
 * Migra refresh do n8n pra Supabase/Vercel cron. Tokens GHL expiram em
 * 24h (expires_in=86399s); fazemos refresh em <23h pra ter margem.
 *
 * Estratégia:
 *   - Cron Vercel diário (1AM ET) chama /api/cron/refresh-ghl-token
 *   - Endpoint lê TODOS companyIds em "Token Refresher"
 *   - Pra cada um, POST https://services.leadconnectorhq.com/oauth/token
 *     com grant_type=refresh_token + refresh_token salvo
 *   - GHL retorna NOVOS access_token + refresh_token (rotation)
 *   - UPSERT na tabela
 *
 * Idempotency: cron pode rodar 2x sem problema — refresh sempre dá novo par.
 * Falha em 1 company não bloqueia os outros — agrega erros e reporta.
 *
 * Fallback: se algum endpoint detectar token expirado (401), invalida cache
 * (já existe `invalidateTokenCache`) e a próxima chamada vai pegar token
 * fresco após refresh (eventual consistency).
 */

import { createGHLTokenClient } from "@/lib/supabase/admin";
import { GHL_API_BASE } from "@/lib/utils/constants";

/**
 * Endpoint OAuth do GHL.
 * O base API usa /oauth/locationToken (diferente), mas refresh/exchange
 * de COMPANY token vão pro mesmo host com path /oauth/token.
 */
function oauthTokenUrl(): string {
  // GHL_API_BASE = "https://services.leadconnectorhq.com" (ver constants.ts)
  return `${GHL_API_BASE}/oauth/token`;
}

interface GHLTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  userType?: string;
  companyId?: string;
  locationId?: string;
  userId?: string;
  refreshTokenId?: string;
  isBulkInstallation?: boolean | string;
}

export interface RefreshResult {
  total: number;
  refreshed: number;
  failed: number;
  failures: Array<{ companyId: string; error: string }>;
}

/**
 * Refresh de 1 token usando o refresh_token salvo.
 * Lança erro em falha (caller agrega).
 */
async function refreshOneToken(refreshToken: string): Promise<GHLTokenResponse> {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GHL_CLIENT_ID/GHL_CLIENT_SECRET não configurados em env");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    user_type: "Company",
  });

  const r = await fetch(oauthTokenUrl(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`refresh failed: ${r.status} — ${text.slice(0, 300)}`);
  }

  return (await r.json()) as GHLTokenResponse;
}

/**
 * Refresh de TODOS os company tokens em "Token Refresher".
 * Chamado pelo cron Vercel diário.
 */
export async function refreshAllCompanyTokens(): Promise<RefreshResult> {
  const supabase = createGHLTokenClient();
  const result: RefreshResult = {
    total: 0,
    refreshed: 0,
    failed: 0,
    failures: [],
  };

  const { data: rows, error } = await supabase
    .from("Token Refresher")
    .select('"companyId", refresh_token');

  if (error) {
    throw new Error(`Token Refresher read failed: ${error.message}`);
  }
  if (!rows || rows.length === 0) {
    return result;
  }

  result.total = rows.length;

  for (const row of rows as Array<{ companyId: string; refresh_token: string }>) {
    try {
      const tokens = await refreshOneToken(row.refresh_token);

      const { error: upErr } = await supabase
        .from("Token Refresher")
        .upsert(
          {
            companyId: row.companyId, // PK
            access_token: tokens.access_token,
            token_type: tokens.token_type,
            expires_in: tokens.expires_in,
            refresh_token: tokens.refresh_token, // rotation — GHL devolve novo
            scope: tokens.scope,
            userType: tokens.userType ?? "Company",
            userId: tokens.userId ?? null,
            refreshTokenId: tokens.refreshTokenId ?? null,
            isBulkInstallation: tokens.isBulkInstallation
              ? String(tokens.isBulkInstallation)
              : null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "companyId" },
        );

      if (upErr) throw new Error(`UPSERT failed: ${upErr.message}`);
      result.refreshed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed++;
      result.failures.push({ companyId: row.companyId, error: msg.slice(0, 500) });
      console.error(
        `[token-refresher] FAIL company=${row.companyId}: ${msg.slice(0, 300)}`,
      );
    }
  }

  return result;
}

/**
 * Exchange inicial: troca um authorization_code (novo install / nova sessão)
 * por access_token + refresh_token. UPSERT na tabela.
 *
 * Pedro 2026-05-17: usado quando rep gera um auth code novo via
 * marketplace install flow.
 */
export async function exchangeAuthCode(params: {
  code: string;
  redirectUri: string;
}): Promise<GHLTokenResponse> {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GHL_CLIENT_ID/GHL_CLIENT_SECRET não configurados");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code: params.code,
    user_type: "Company",
    redirect_uri: params.redirectUri,
  });

  const r = await fetch(oauthTokenUrl(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`exchange failed: ${r.status} — ${text.slice(0, 500)}`);
  }

  const tokens = (await r.json()) as GHLTokenResponse;

  if (!tokens.companyId) {
    throw new Error("OAuth response sem companyId — não dá pra UPSERT na tabela");
  }

  const supabase = createGHLTokenClient();
  const { error } = await supabase
    .from("Token Refresher")
    .upsert(
      {
        companyId: tokens.companyId,
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        userType: tokens.userType ?? "Company",
        userId: tokens.userId ?? null,
        refreshTokenId: tokens.refreshTokenId ?? null,
        isBulkInstallation: tokens.isBulkInstallation
          ? String(tokens.isBulkInstallation)
          : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "companyId" },
    );

  if (error) throw new Error(`UPSERT failed: ${error.message}`);

  return tokens;
}
