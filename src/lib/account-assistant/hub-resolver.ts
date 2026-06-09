/**
 * hub-resolver.ts — helper compartilhado pra resolver o locationId e agentId
 * do hub Sparkbot ativo.
 *
 * Motivação (H29 2026-05-20): antes cada ponto do sistema (reminder-runner,
 * whatsapp-delivery, send/route, transcribe/route, etc.) lia direto a env var
 * ASSISTANT_HUB_LOCATION_ID — single-hub hardcoded. Multi-hub real exige
 * query DB. Este helper encapsula:
 *   1. Query DB: agents WHERE type='account_assistant' AND status='active'
 *      (mesma lógica do isSparkbotHub no webhook inbound, que já é multi-hub)
 *   2. Fallback: env var ASSISTANT_HUB_LOCATION_ID (legacy, opcional pós-refactor)
 *   3. Cache in-memory 5min — hot path dos crons proativos não bate DB a cada 30s
 *
 * Backward-compat com 1 hub (caso atual de prod):
 *   - Se DB tem exatamente 1 agent account_assistant ativo → retorna seu location_id
 *   - Esse location_id é o mesmo que ASSISTANT_HUB_LOCATION_ID apontava
 *   - Comportamento IDÊNTICO ao anterior
 *
 * Se DB não achar nenhum (agent desativado, DB offline, etc.): cai na env var.
 * Assim a env continua funcionando como safety net durante transição.
 */

import { createAdminClient } from "@/lib/supabase/admin";

const HUB_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — mesmo TTL do isSparkbotHub no webhook

export interface HubEntry {
  locationId: string;
  agentId: string;
}

// Cache da lista de hubs ativos (para resolveActiveHubAgents)
let hubListCache: { entries: HubEntry[]; expiresAt: number } | null = null;
// Cache das companies (agências) que têm hub ativo (gate company-aware)
let hubCompanyCache: { companies: Set<string>; expiresAt: number } | null = null;

/**
 * Retorna todos os hubs Sparkbot ativos (location_id + agent_id).
 * Multi-hub ready: retorna N entradas; caso atual (1 hub) retorna array de 1.
 * Usa cache in-memory pra não bater DB a cada cron tick.
 */
export async function resolveActiveHubAgents(): Promise<HubEntry[]> {
  const now = Date.now();
  if (hubListCache && hubListCache.expiresAt > now) {
    return hubListCache.entries;
  }

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("agents")
      .select("id, location_id")
      .eq("type", "account_assistant")
      .eq("status", "active");

    if (error) {
      console.warn(
        "[hub-resolver] query DB falhou — usando fallback env:",
        error.message,
      );
      return _envFallbackList();
    }

    if (!data || data.length === 0) {
      console.warn(
        "[hub-resolver] nenhum hub ativo no DB — usando fallback env",
      );
      return _envFallbackList();
    }

    const entries: HubEntry[] = data.map((row) => ({
      locationId: row.location_id as string,
      agentId: row.id as string,
    }));
    hubListCache = { entries, expiresAt: now + HUB_CACHE_TTL_MS };
    return entries;
  } catch (err) {
    console.warn(
      "[hub-resolver] exceção na query — usando fallback env:",
      err instanceof Error ? err.message : err,
    );
    return _envFallbackList();
  }
}

/**
 * Retorna o primeiro hub ativo (locationId + agentId), ou null se não achar.
 * Caso atual de prod: 1 hub → equivale exatamente ao ASSISTANT_HUB_LOCATION_ID.
 * Futuramente: retorna o hub "principal" (primeiro cadastrado / alphabético).
 */
export async function resolvePrimaryHub(): Promise<HubEntry | null> {
  const hubs = await resolveActiveHubAgents();
  return hubs.length > 0 ? hubs[0] : null;
}

/**
 * Gate de visibilidade (Pedro 2026-06-05): a location TEM o app SparkBot
 * instalado? = tem um agente `account_assistant` ATIVO. Usado pelo /check-admin
 * pra NÃO vazar o widget do SparkBot pra locations sem o app — o loader é
 * injetado no nível da AGÊNCIA do GHL, então carrega em TODAS as locations da
 * agência. Reusa a lista cacheada (5min) de hubs ativos.
 *
 * Fail-closed via resolveActiveHubAgents: se o DB cair, só o hub da env
 * (ASSISTANT_HUB_LOCATION_ID) passa — melhor esconder do que vazar.
 */
export async function isLocationSparkbotHub(locationId: string): Promise<boolean> {
  if (!locationId) return false;
  const hubs = await resolveActiveHubAgents();
  return hubs.some((h) => h.locationId === locationId);
}

/** Companies (agências) que têm um hub SparkBot ativo. Cacheado 5min. */
async function resolveHubCompanies(): Promise<Set<string>> {
  const now = Date.now();
  if (hubCompanyCache && hubCompanyCache.expiresAt > now) return hubCompanyCache.companies;
  const hubs = await resolveActiveHubAgents();
  const hubLocs = hubs.map((h) => h.locationId).filter(Boolean);
  if (hubLocs.length === 0) return new Set();
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("locations")
      .select("company_id")
      .in("location_id", hubLocs);
    const companies = new Set<string>(
      (data || []).map((r) => r.company_id as string).filter(Boolean),
    );
    hubCompanyCache = { companies, expiresAt: now + HUB_CACHE_TTL_MS };
    return companies;
  } catch {
    return new Set();
  }
}

/**
 * Gate de visibilidade COMPANY-AWARE (Pedro 2026-06-09): a AGÊNCIA (company) da
 * location tem o SparkBot? O SparkBot é 1 hub por agência que serve TODAS as
 * sub-accounts dela — então o widget deve aparecer em QUALQUER location da
 * agência, não só na location exata do hub.
 *
 * Fix bug observado em prod 2026-06-09 (Alves Cury): o gate antigo
 * (isLocationSparkbotHub) só liberava a location do hub → o widget sumia em
 * todas as outras sub-accounts da MESMA agência (Alves Cury é company igual ao
 * hub, mas location diferente). Agora libera por company.
 *
 * Fail-closed: erro de lookup → false (melhor esconder do que vazar pra fora
 * da agência).
 */
export async function isLocationSparkbotEnabled(locationId: string): Promise<boolean> {
  if (!locationId) return false;
  // Fast path: a própria location é o hub.
  if (await isLocationSparkbotHub(locationId)) return true;
  // Senão: a company da location tem um hub ativo?
  try {
    const supabase = createAdminClient();
    const { data: loc } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", locationId)
      .maybeSingle();
    if (!loc?.company_id) return false;
    const hubCompanies = await resolveHubCompanies();
    return hubCompanies.has(loc.company_id as string);
  } catch {
    return false;
  }
}

/**
 * Invalida o cache imediatamente (útil em testes ou após mudança de agent).
 */
export function invalidateHubCache(): void {
  hubListCache = null;
  hubCompanyCache = null;
}

// ---------------------------------------------------------------------------
// Fallback: lê env ASSISTANT_HUB_LOCATION_ID + faz query ao DB pelo agentId.
// Garante backward-compat durante período de transição (env ainda setada).
// ---------------------------------------------------------------------------
function _envFallbackList(): HubEntry[] {
  const envLoc = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  if (!envLoc) return [];
  // Retorna entrada sem agentId resolvido — caller deve buscar agentId separado
  // se necessário. Em _envFallbackList não fazemos query (sync, evita await-in-catch).
  // Callers que precisam do agentId e caíram aqui farão a query inline.
  return [{ locationId: envLoc, agentId: "" }];
}

/**
 * Helper síncrono: retorna o locationId da env (legacy) sem query DB.
 * Útil como último fallback em paths onde já tentamos o DB.
 */
export function getEnvHubLocationId(): string | undefined {
  return process.env.ASSISTANT_HUB_LOCATION_ID?.trim() || undefined;
}
