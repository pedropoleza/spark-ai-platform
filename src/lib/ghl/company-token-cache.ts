/**
 * Cache em memória do COMPANY token do Spark Leads (H93, incidente 2026-09-20).
 *
 * POR QUE EXISTE: o company token é lido do Supabase "GHL Token" em TODA geração
 * de location token. Como o cache de LOCATION token dura 20min e vive por lambda,
 * na prática isso virou **291 mil leituras por dia pra ler UMA linha**. O projeto
 * (compartilhado com outros apps) saturou: queries triviais levando 11-14s,
 * `could not accept SSL connection`, `current transaction is aborted`, janelas de
 * minutos sem responder. E o ciclo se realimenta — com o token vencido, cada
 * chamada lê 3 a 5 vezes em vez de 1.
 *
 * A TRAVA QUE TORNA SEGURO: só serve do cache um token que ainda está LONGE de
 * vencer. Token vencido ou vencendo sempre relê o banco — então nem o self-heal
 * inline nem a recuperação cross-lambda atrasam um segundo. O cache economiza
 * exatamente no caso saudável, que é onde está todo o volume.
 *
 * Módulo separado de propósito: `auth.ts` e `token-refresher.ts` já se importam
 * um ao outro; pendurar o cache em qualquer um dos dois fecharia o ciclo.
 */

export interface CompanyTokenRow {
  access_token: string;
  companyId: string;
  expires_in: number | null;
  updated_at: string | null;
}

const cache = new Map<string, { meta: CompanyTokenRow; cachedAt: number }>();

const TTL_MS = 5 * 60 * 1000;
/** Dentro desta margem do vencimento o cache é ignorado (é justo quando renova). */
const MARGEM_SEGURA_MS = 3 * 60 * 60 * 1000;

/**
 * Devolve o token cacheado, ou null quando não há / está velho / está perto de
 * vencer. `perto` é injetado (o cálculo mora em `auth.ts`) pra este módulo
 * continuar sem dependência.
 */
export function lerCompanyTokenCache(
  companyId: string,
  perto: (meta: CompanyTokenRow, agoraMs: number, margemMs: number) => boolean,
): CompanyTokenRow | null {
  const hit = cache.get(companyId);
  if (!hit) return null;
  const agora = Date.now();
  if (agora - hit.cachedAt >= TTL_MS) return null;
  if (perto(hit.meta, agora, MARGEM_SEGURA_MS)) return null;
  return hit.meta;
}

export function gravarCompanyTokenCache(companyId: string, meta: CompanyTokenRow): void {
  cache.set(companyId, { meta, cachedAt: Date.now() });
}

/**
 * Invalida o cache. Chamado depois de todo refresh/upsert — senão o
 * `getCompanyMeta` logo após o self-heal releria o token que acabou de ser
 * substituído.
 */
export function invalidateCompanyTokenCache(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}
