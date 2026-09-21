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
import { invalidateCompanyTokenCache } from "./company-token-cache";
import {
  lerTokenEspelho,
  gravarTokenEspelho,
  listarCompaniesEspelhadas,
} from "./company-token-store";
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
 * UPSERT do par de tokens (access + refresh rotacionado) na "Token Refresher".
 * Fonte ÚNICA do mapeamento GHLTokenResponse→colunas — usada pelo cron
 * (refreshAllCompanyTokens), pelo self-heal inline (refreshCompanyToken) e pelo
 * exchange inicial (exchangeAuthCode), pra esses três não driftarem.
 */
async function upsertCompanyTokens(
  supabase: ReturnType<typeof createGHLTokenClient>,
  companyId: string,
  tokens: GHLTokenResponse,
): Promise<void> {
  // H93 (2026-09-21) — ESPELHO PRIMEIRO, e é isto que impede o bug se repetir.
  // O refresh_token do GHL é de USO ÚNICO: quando chegamos aqui o GHL JÁ
  // rotacionou, então o par novo só existe nesta variável. Gravar antes no banco
  // principal (saudável) garante que a rotação não se perca se a "Token
  // Refresher" (projeto separado, instável) estiver fora — foi exatamente assim
  // que a tabela ficou com um refresh_token morto e a plataforma passou 36h fora.
  await gravarTokenEspelho(companyId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    scope: tokens.scope,
    userType: tokens.userType ?? "Company",
    userId: tokens.userId ?? null,
    refreshTokenId: tokens.refreshTokenId ?? null,
    isBulkInstallation: tokens.isBulkInstallation ? String(tokens.isBulkInstallation) : null,
    updated_at: new Date().toISOString(),
  });
  invalidateCompanyTokenCache(companyId);

  const { error } = await supabase.from("Token Refresher").upsert(
    {
      companyId, // PK
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

  // A tabela original é BEST-EFFORT desde o H93: o par já está salvo no espelho,
  // então uma falha aqui não pode mais derrubar o refresh (era o que perdia a
  // rotação). Segue sendo escrita porque há outros consumidores lendo dela.
  if (error) {
    console.warn(
      `[token-refresher] espelho OK, mas a "Token Refresher" recusou (company=${companyId}): ${error.message}`,
    );
  }
}

/**
 * Refresh INLINE (on-demand) de UM company token + UPSERT — self-heal do
 * SPOF de auth (H38, Pedro 2026-06-10).
 *
 * Usado pelo `auth.ts` quando um locationToken volta 401 porque o company token
 * expirou FORA do cron diário (ex: o cron `/api/cron/refresh-ghl-token` falhou).
 * Antes, a única recuperação era o próximo cron + re-run manual; agora a 1ª call
 * que tropeça no 401 renova o par e re-tenta na hora.
 *
 * Lê o refresh_token salvo, faz POST grant_type=refresh_token e grava o par novo.
 * Lança erro limpo se não houver refresh_token ou se o refresh falhar (caller
 * trata — ex: refresh_token revogado = auth realmente quebrado).
 */
// Anti-thundering-herd (Pedro 2026-06-13, apagão de auth). O refresh_token do
// GHL é de USO ÚNICO — rotaciona a cada refresh bem-sucedido. Quando o company
// token vence, CENTENAS de requests concorrentes caíam aqui ao mesmo tempo, cada
// uma lendo o MESMO refresh_token salvo e fazendo POST /oauth/token. O GHL aceita
// só a 1ª (rotaciona → invalida o refresh_token usado) e responde 401
// invalid_grant pro resto. Sob essa thrash a rotação às vezes se perdia (vencedor
// não salvava antes da próxima onda reler o token já invalidado) → "Token
// Refresher" travava num refresh_token morto e NADA renovava (49k on-demand + 21k
// falhas em ~26h, integração fora). Uma única chamada SERIALIZADA recuperou.
//
// Fix: coalescing in-memory por companyId — refreshes concorrentes NA MESMA
// lambda compartilham UMA Promise (some o herd intra-lambda). Cross-lambda, o
// vencedor salva o token válido e os perdedores re-leem o válido na próxima.
// + cooldown pós-falha: se acabou de FALHAR, não martela o GHL de novo por
// COOLDOWN_MS — se o refresh_token estiver genuinamente revogado (precisa
// re-auth), evita repetir o storm de 401.
const inFlightRefresh = new Map<string, Promise<GHLTokenResponse>>();
const lastRefreshFailAt = new Map<string, number>();
const REFRESH_FAIL_COOLDOWN_MS = 10_000;

export async function refreshCompanyToken(
  companyId: string,
): Promise<GHLTokenResponse> {
  const inFlight = inFlightRefresh.get(companyId);
  if (inFlight) return inFlight; // junta na chamada em voo — não dispara outra

  const failedAt = lastRefreshFailAt.get(companyId);
  if (failedAt && Date.now() - failedAt < REFRESH_FAIL_COOLDOWN_MS) {
    throw new Error(
      `refresh em cooldown pra companyId=${companyId} (falhou há <${REFRESH_FAIL_COOLDOWN_MS}ms — ` +
        `provável refresh_token revogado: precisa RE-AUTORIZAR o app, não adianta retry)`,
    );
  }

  const p = doRefreshCompanyToken(companyId);
  inFlightRefresh.set(companyId, p);
  try {
    const tokens = await p;
    lastRefreshFailAt.delete(companyId);
    return tokens;
  } catch (e) {
    lastRefreshFailAt.set(companyId, Date.now());
    throw e;
  } finally {
    inFlightRefresh.delete(companyId);
  }
}

async function doRefreshCompanyToken(
  companyId: string,
): Promise<GHLTokenResponse> {
  const supabase = createGHLTokenClient();

  // H93: espelho primeiro — com o projeto de tokens fora, esta leitura era o que
  // impedia até o self-heal de rodar.
  let refreshToken = (await lerTokenEspelho(companyId).catch(() => null))?.refresh_token;
  let erroLegado = "";
  if (!refreshToken) {
    const { data, error } = await supabase
      .from("Token Refresher")
      .select('"companyId", refresh_token')
      .eq("companyId", companyId)
      .single();
    refreshToken = (data as { refresh_token?: string } | null)?.refresh_token;
    erroLegado = error ? `: ${error.message}` : "";
  }
  if (!refreshToken) {
    throw new Error(`Sem refresh_token pra companyId=${companyId}${erroLegado}`);
  }

  const tokens = await refreshOneToken(refreshToken);
  await upsertCompanyTokens(supabase, companyId, tokens);
  return tokens;
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

  // H93: espelho primeiro. O cron de 21/09 crashou em `Token Refresher read
  // failed: connection timeout` e por isso o token venceu sem renovação.
  let rows = await listarCompaniesEspelhadas().catch(() => []);
  if (rows.length === 0) {
    const { data, error } = await supabase
      .from("Token Refresher")
      .select('"companyId", refresh_token');
    if (error) {
      throw new Error(`Token Refresher read failed: ${error.message}`);
    }
    rows = (data || []) as Array<{ companyId: string; refresh_token: string }>;
  }
  if (rows.length === 0) {
    return result;
  }

  result.total = rows.length;

  for (const row of rows) {
    try {
      const tokens = await refreshOneToken(row.refresh_token);
      await upsertCompanyTokens(supabase, row.companyId, tokens);
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
  await upsertCompanyTokens(supabase, tokens.companyId, tokens);

  return tokens;
}
