import { createGHLTokenClient } from "@/lib/supabase/admin";
import { GHL_API_BASE, GHL_API_VERSION } from "@/lib/utils/constants";
import type { GHLTokenResponse } from "@/types/ghl";
import { refreshCompanyToken } from "./token-refresher";
import { reportError } from "@/lib/admin-signals/report-error";

// Cache de location tokens em memoria (por locationId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Mutex de in-flight LOCATION token refresh por (companyId, locationId).
// Evita 37 requests paralelas (list_my_free_slots) baterem todos no
// /oauth/locationToken simultaneamente quando cache expira — só 1 refresh
// real, restantes aguardam mesma promise.
// Bug observado em prod: token expirado + Promise.all 37 → 37 refreshes
// concorrentes → rate limit do GHL token endpoint.
const inFlightTokenRefresh = new Map<string, Promise<string>>();

// Mutex de in-flight COMPANY token refresh por companyId (separado do location
// mutex acima). SPOF hardening (H38, Pedro 2026-06-10): quando o company token expira
// e N locations da mesma company tropeçam no 401 do locationToken ao mesmo tempo,
// queremos UM só refresh do company token — os demais aguardam a mesma promise.
// É keyed por companyId (não por location) de propósito: o company token é
// compartilhado por todas as locations da company.
const inFlightCompanyRefresh = new Map<string, Promise<void>>();

// Margem pro refresh PROATIVO do company token: renova quando faltam <2h pra
// expirar. O token dura ~24h e o cron diário (/api/cron/refresh-ghl-token)
// normalmente renova bem antes — então essa margem só dispara se o cron vinha
// falhando, virando a rede de segurança antes do 401 reativo acontecer.
const COMPANY_TOKEN_PROACTIVE_MARGIN_MS = 2 * 60 * 60 * 1000;

/**
 * Busca o company token no Supabase (Token Refresher table).
 * Devolve também `expires_in`/`updated_at` (já vêm no SELECT *) pra o caller
 * decidir refresh proativo — ver `isCompanyTokenNearExpiry`.
 */
export async function getCompanyToken(companyId: string): Promise<{
  access_token: string;
  companyId: string;
  expires_in: number | null;
  updated_at: string | null;
}> {
  const supabase = createGHLTokenClient();

  const { data, error } = await supabase
    .from("Token Refresher")
    .select("*")
    .eq("companyId", companyId)
    .single();

  if (error || !data) {
    throw new Error(`Token nao encontrado para companyId: ${companyId}`);
  }

  return {
    access_token: data.access_token,
    companyId: data.companyId,
    expires_in: data.expires_in ?? null,
    updated_at: data.updated_at ?? null,
  };
}

export interface CompanyTokenMeta {
  access_token: string;
  expires_in?: number | null;
  updated_at?: string | null;
}

export interface LocationTokenFetchResult {
  status: number;
  ok: boolean;
  access_token?: string;
  bodyText?: string;
}

/**
 * Dependências injetáveis do `generateLocationToken`. Em prod vêm de
 * `realLocationTokenDeps()`; nos testes (`scripts/test-ghl-auth-selfheal.ts`)
 * são fakes — assim a orquestração do self-heal é exercitada sem rede/DB.
 */
export interface LocationTokenDeps {
  getCompanyMeta: (companyId: string) => Promise<CompanyTokenMeta>;
  refreshCompany: (companyId: string) => Promise<void>;
  fetchLocationToken: (
    companyAccessToken: string,
    companyId: string,
    locationId: string,
  ) => Promise<LocationTokenFetchResult>;
  now: () => number;
  proactiveEnabled: boolean;
  proactiveMarginMs: number;
  /** Disparado quando o 401 reativo engata o refresh inline (cron pode ter falhado). */
  onSelfHealEngaged?: (companyId: string) => void;
  /** Disparado quando, mesmo após o refresh inline, o locationToken segue falhando. */
  onSelfHealFailed?: (companyId: string, status: number) => void;
}

/**
 * Decide se o company token está perto de expirar com base em `expires_in` +
 * `updated_at` gravados na "Token Refresher". Pura — testável sem rede/DB.
 *
 * Fail-safe: retorna `false` (NÃO renova proativamente) quando os metadados
 * estão ausentes ou malformados — nesse caso confiamos no cron + no self-heal
 * reativo (401), em vez de arriscar um refresh desnecessário às cegas.
 */
export function isCompanyTokenNearExpiry(
  meta: { expires_in?: number | null; updated_at?: string | null },
  nowMs: number,
  marginMs: number,
): boolean {
  if (!meta.expires_in || !meta.updated_at) return false;
  const issuedMs = Date.parse(meta.updated_at);
  if (Number.isNaN(issuedMs)) return false;
  const expiresAtMs = issuedMs + meta.expires_in * 1000;
  return expiresAtMs - nowMs <= marginMs;
}

/**
 * Coalesce de refresh do COMPANY token por companyId via `inFlightCompanyRefresh`.
 * Um burst de calls (N locations) que tropeçam no mesmo company token expirado
 * dispara UM só refresh real — os demais aguardam a mesma promise. Limpa o mutex
 * no finally (sucesso ou falha → próxima tentativa refaz).
 */
export function coalesceCompanyRefresh(
  companyId: string,
  doRefresh: (companyId: string) => Promise<unknown>,
): Promise<void> {
  const existing = inFlightCompanyRefresh.get(companyId);
  if (existing) return existing;

  const p = (async () => {
    try {
      await doRefresh(companyId);
    } finally {
      inFlightCompanyRefresh.delete(companyId);
    }
  })();

  inFlightCompanyRefresh.set(companyId, p);
  return p;
}

/**
 * Gera um location token a partir do company token, com SELF-HEAL do company
 * token (H38, Pedro 2026-06-10, SPOF hardening). Orquestração pura sobre `deps` —
 * sem estado (cache/mutex ficam no `getLocationToken`), pra ser testável.
 *
 * Fluxo:
 *   1. (opcional) refresh PROATIVO se o company token está perto de expirar.
 *   2. POST /oauth/locationToken com o company token.
 *   3. Se 401 ⇒ company token expirou (cron diário falhou). Refresh inline 1×
 *      (mutex coalesce N→1) e re-tenta. Se o refresh lançar (ex: rotação do
 *      refresh_token por outra lambda), re-lê o DB mesmo assim — outra lambda
 *      pode ter renovado.
 *   4. Se ainda falhar ⇒ erro limpo (auth realmente quebrado).
 */
export async function generateLocationToken(
  companyId: string,
  locationId: string,
  deps: LocationTokenDeps,
): Promise<string> {
  let meta = await deps.getCompanyMeta(companyId);

  // 1. Refresh PROATIVO (opcional). Fail-soft: dentro da margem o token atual
  // ainda é válido, então uma falha aqui não é fatal — seguimos com ele e
  // deixamos o cron / o self-heal reativo cobrirem.
  if (
    deps.proactiveEnabled &&
    isCompanyTokenNearExpiry(meta, deps.now(), deps.proactiveMarginMs)
  ) {
    try {
      await deps.refreshCompany(companyId);
      meta = await deps.getCompanyMeta(companyId);
    } catch (e) {
      console.warn(
        `[GHL] refresh proativo do company token falhou (company=${companyId}), seguindo com token atual: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  let res = await deps.fetchLocationToken(meta.access_token, companyId, locationId);

  // 3. Self-heal REATIVO (core do fix): 401 ⇒ company token expirado.
  let selfHealAttempted = false;
  if (res.status === 401) {
    selfHealAttempted = true;
    deps.onSelfHealEngaged?.(companyId);
    console.warn(
      `[GHL] locationToken 401 (company=${companyId}) — self-heal: renovando company token inline`,
    );
    try {
      await deps.refreshCompany(companyId);
    } catch (e) {
      // Pode ter sido a rotação do refresh_token por outra lambda concorrente
      // (o RT que líamos já foi consumido). Re-lemos o DB mesmo assim: se outra
      // lambda renovou, pegamos o par fresco; senão o retry abaixo dá erro limpo.
      console.warn(
        `[GHL] refresh inline lançou (company=${companyId}), re-lendo token do DB mesmo assim: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
    meta = await deps.getCompanyMeta(companyId);
    res = await deps.fetchLocationToken(meta.access_token, companyId, locationId);
  }

  // 4. Erro limpo se ainda falhou.
  if (!res.ok || !res.access_token) {
    if (selfHealAttempted) deps.onSelfHealFailed?.(companyId, res.status);
    throw new Error(
      `Falha ao gerar location token: ${res.status} - ${res.bodyText ?? ""}`,
    );
  }

  return res.access_token;
}

/** POST real ao /oauth/locationToken, normalizado pra `LocationTokenFetchResult`. */
async function realFetchLocationToken(
  companyAccessToken: string,
  companyId: string,
  locationId: string,
): Promise<LocationTokenFetchResult> {
  const response = await fetch(`${GHL_API_BASE}/oauth/locationToken`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Version: GHL_API_VERSION,
      Authorization: `Bearer ${companyAccessToken}`,
    },
    body: new URLSearchParams({
      companyId,
      locationId,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    return { status: response.status, ok: false, bodyText };
  }

  const data: GHLTokenResponse = await response.json();
  return { status: response.status, ok: true, access_token: data.access_token };
}

/** Dependências reais (prod) do `generateLocationToken`. */
function realLocationTokenDeps(): LocationTokenDeps {
  return {
    getCompanyMeta: getCompanyToken,
    refreshCompany: (companyId) =>
      coalesceCompanyRefresh(companyId, refreshCompanyToken),
    fetchLocationToken: realFetchLocationToken,
    now: () => Date.now(),
    // Kill switch: setar GHL_PROACTIVE_COMPANY_REFRESH=0 desliga só o proativo
    // (o self-heal reativo no 401 continua sempre ligado — é o fix do SPOF).
    proactiveEnabled: process.env.GHL_PROACTIVE_COMPANY_REFRESH !== "0",
    proactiveMarginMs: COMPANY_TOKEN_PROACTIVE_MARGIN_MS,
    onSelfHealEngaged: (companyId) =>
      reportError({
        // Title ESTÁVEL (sem var) pra deduplicar no /hub/admin/health.
        title:
          "Spark Leads: token de empresa renovado on-demand (renovação diária pode estar falhando)",
        feature: "ghl-auth",
        severity: "high",
        description:
          "Um token de location voltou 401 e o self-heal inline renovou o token de empresa fora da renovação diária agendada. Verificar o cron /api/cron/refresh-ghl-token — se ele estivesse saudável, esse 401 não teria acontecido.",
        metadata: { companyId },
      }),
    onSelfHealFailed: (companyId, status) =>
      reportError({
        title: "Spark Leads: falha ao renovar token de empresa (auth pode estar fora)",
        feature: "ghl-auth",
        severity: "critical",
        description:
          "O self-heal inline tentou renovar o token de empresa mas o location token seguiu falhando. A integração com o Spark Leads pode estar totalmente fora — checar refresh_token/credenciais na Token Refresher.",
        metadata: { companyId, status },
      }),
  };
}

/**
 * Gera (e cacheia) um location token a partir do company token.
 * Usa mutex `inFlightTokenRefresh` pra coalescer requests paralelas
 * concorrentes — só 1 fetch real ao /oauth/locationToken, restantes
 * aguardam a mesma promise (fix audit 2026-05-05 HIGH-1).
 *
 * A geração em si (incl. o self-heal do company token) está em
 * `generateLocationToken`; aqui ficam só o cache e o mutex de location.
 */
export async function getLocationToken(
  companyId: string,
  locationId: string,
): Promise<string> {
  // Verificar cache
  const cacheKey = `${companyId}:${locationId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Se já tem refresh in-flight pra essa key, aguarda mesma promise.
  const inFlight = inFlightTokenRefresh.get(cacheKey);
  if (inFlight) return inFlight;

  // Cria promise e registra ANTES de await — pra outras chamadas
  // concorrentes pegarem essa promise via inFlight check acima.
  const refreshPromise = (async () => {
    try {
      const token = await generateLocationToken(
        companyId,
        locationId,
        realLocationTokenDeps(),
      );

      // Cachear por 20 minutos (token GHL expira em ~24h, mas renovamos com frequencia)
      tokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + 20 * 60 * 1000,
      });

      return token;
    } finally {
      // Sempre limpa o mutex — sucesso ou falha (próxima chamada tenta de novo)
      inFlightTokenRefresh.delete(cacheKey);
    }
  })();

  inFlightTokenRefresh.set(cacheKey, refreshPromise);
  return refreshPromise;
}

/**
 * Invalida o cache de token para uma location
 */
export function invalidateTokenCache(companyId: string, locationId: string) {
  tokenCache.delete(`${companyId}:${locationId}`);
}
