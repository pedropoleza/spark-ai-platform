/**
 * Filter Engine — cache in-memory.
 *
 * Pedro 2026-05-15: TTL 10min pra pipelines + custom fields.
 *
 * Por location, salva pipelines (stages) e custom fields (id + slug +
 * type). Compartilhado entre executions do mesmo processo Node — não é
 * Redis, então não cross-process. Reset em deploy/restart.
 *
 * Stale-while-revalidate: quando TTL expira, primeira leitura ainda
 * devolve valor antigo SE re-fetch falhar. Falhas de re-fetch logam
 * warning mas não quebram requests.
 */

import type { GHLClient } from "@/lib/ghl/client";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10min

interface CacheEntry<T> {
  value: T;
  fetched_at: number;
  /** Mantido pra stale-while-revalidate */
  prev_value?: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

function key(location_id: string, resource: string): string {
  return `${location_id}:${resource}`;
}

/** Retorna entry se válida; senão null. */
function getEntry<T>(k: string): CacheEntry<T> | null {
  const entry = cache.get(k) as CacheEntry<T> | undefined;
  if (!entry) return null;
  return entry;
}

function isFresh<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.fetched_at < CACHE_TTL_MS;
}

// =====================================================================
// Pipelines + Stages
// =====================================================================

export interface CachedPipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string; position?: number }>;
}

export async function getPipelines(
  ghl: GHLClient,
  location_id: string,
  options: { bypass_cache?: boolean } = {},
): Promise<CachedPipeline[]> {
  const k = key(location_id, "pipelines");
  if (!options.bypass_cache) {
    const entry = getEntry<CachedPipeline[]>(k);
    if (entry && isFresh(entry)) return entry.value;
  }

  try {
    const res = await ghl.get<{
      pipelines?: Array<{
        id: string;
        name?: string;
        stages?: Array<{ id: string; name?: string; position?: number }>;
      }>;
    }>("/opportunities/pipelines", { locationId: location_id });

    const value: CachedPipeline[] = (res.pipelines || []).map((p) => ({
      id: p.id,
      name: p.name || "(sem nome)",
      stages: (p.stages || []).map((s) => ({
        id: s.id,
        name: s.name || "(sem nome)",
        position: s.position,
      })),
    }));

    cache.set(k, { value, fetched_at: Date.now() });
    return value;
  } catch (err) {
    // Stale-while-revalidate: usa valor antigo se houver
    const stale = cache.get(k) as CacheEntry<CachedPipeline[]> | undefined;
    if (stale) {
      console.warn(
        `[filter-engine cache] pipelines fetch falhou pra ${location_id}, usando stale:`,
        err instanceof Error ? err.message : err,
      );
      return stale.value;
    }
    throw err;
  }
}

// =====================================================================
// Custom Fields
// =====================================================================

export interface CachedCustomField {
  id: string;
  /** Slug human-friendly (ex: 'aap_range'). Pode estar ausente em CFs antigos. */
  fieldKey?: string;
  /** Nome display (ex: 'Average Annual Premium Range') */
  name?: string;
  /** GHL CF dataType (TEXT, NUMERICAL, MONETARY, SINGLE_OPTIONS, DATE, etc) */
  dataType?: string;
  /** Pra SINGLE_OPTIONS / MULTIPLE_OPTIONS */
  picklistOptions?: string[];
  /**
   * 'contact' | 'opportunity'. Fix Pedro 2026-05-15: descoberto via probe
   * que GHL tem CFs separados por model. Default `/customFields` retorna
   * só contact; precisa `?model=opportunity` pra opp.
   */
  model?: "contact" | "opportunity";
}

/**
 * Custom fields de CONTACT. Endpoint default `/locations/{id}/customFields`
 * retorna SÓ contact (probe 2026-05-15).
 */
export async function getCustomFields(
  ghl: GHLClient,
  location_id: string,
  options: { bypass_cache?: boolean } = {},
): Promise<CachedCustomField[]> {
  return fetchCustomFieldsByModel(ghl, location_id, "contact", options);
}

/**
 * Custom fields de OPPORTUNITY. Pedro 2026-05-15: rep tentou filtrar opps
 * por `policy_anniversary` (CF de opp) e engine retornou erro porque só
 * conhecia CFs de contact. Endpoint `?model=opportunity` resolve.
 */
export async function getOpportunityCustomFields(
  ghl: GHLClient,
  location_id: string,
  options: { bypass_cache?: boolean } = {},
): Promise<CachedCustomField[]> {
  return fetchCustomFieldsByModel(ghl, location_id, "opportunity", options);
}

async function fetchCustomFieldsByModel(
  ghl: GHLClient,
  location_id: string,
  model: "contact" | "opportunity",
  options: { bypass_cache?: boolean } = {},
): Promise<CachedCustomField[]> {
  const k = key(location_id, `customFields:${model}`);
  if (!options.bypass_cache) {
    const entry = getEntry<CachedCustomField[]>(k);
    if (entry && isFresh(entry)) return entry.value;
  }

  try {
    // Default endpoint retorna só contact. Pra opportunity, passa ?model=opportunity.
    const params: Record<string, string> = {};
    if (model === "opportunity") params.model = "opportunity";

    const res = await ghl.get<{
      customFields?: Array<{
        id: string;
        fieldKey?: string;
        name?: string;
        dataType?: string;
        picklistOptions?: string[];
        model?: string;
      }>;
    }>(`/locations/${location_id}/customFields`, params);

    const value: CachedCustomField[] = (res.customFields || []).map((cf) => ({
      id: cf.id,
      fieldKey: cf.fieldKey,
      name: cf.name,
      dataType: cf.dataType,
      picklistOptions: cf.picklistOptions,
      model: (cf.model === "opportunity" ? "opportunity" : "contact") as "contact" | "opportunity",
    }));

    cache.set(k, { value, fetched_at: Date.now() });
    return value;
  } catch (err) {
    const stale = cache.get(k) as CacheEntry<CachedCustomField[]> | undefined;
    if (stale) {
      console.warn(
        `[filter-engine cache] customFields(${model}) fetch falhou pra ${location_id}, usando stale:`,
        err instanceof Error ? err.message : err,
      );
      return stale.value;
    }
    throw err;
  }
}

/**
 * Util: retorna TODOS os CFs da location (contact + opportunity), com
 * field `model` claro. Usado por describe_filter_capabilities.
 */
export async function getAllCustomFields(
  ghl: GHLClient,
  location_id: string,
  options: { bypass_cache?: boolean } = {},
): Promise<CachedCustomField[]> {
  const [contact, opportunity] = await Promise.all([
    getCustomFields(ghl, location_id, options).catch(() => [] as CachedCustomField[]),
    getOpportunityCustomFields(ghl, location_id, options).catch(() => [] as CachedCustomField[]),
  ]);
  return [...contact, ...opportunity];
}

// =====================================================================
// Cache invalidation (usado em tests ou após admin mudar pipelines)
// =====================================================================

export function invalidateLocation(location_id: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${location_id}:`)) cache.delete(k);
  }
}

export function invalidateAll(): void {
  cache.clear();
}

export function getCacheStats(): {
  entries: number;
  by_resource: Record<string, number>;
  hit_locations: string[];
} {
  const by_resource: Record<string, number> = {};
  const locations = new Set<string>();
  for (const k of cache.keys()) {
    const [loc, resource] = k.split(":");
    locations.add(loc);
    by_resource[resource] = (by_resource[resource] || 0) + 1;
  }
  return {
    entries: cache.size,
    by_resource,
    hit_locations: Array.from(locations),
  };
}
