/**
 * Repositório do cache `group_contacts` (H46, 2026-06-28).
 * Cache local de contatos-grupo (email @g.us) por location — ver migration 00119.
 * Não lança: loga e devolve fallback (chamado em hot path de tool). service_role.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface GroupContactRow {
  id: string;
  location_id: string;
  contact_id: string;
  jid: string;
  group_name: string | null;
  tags: string[] | null;
  member_count: number | null;
  is_archived: boolean;
  last_synced_at: string;
}

export interface GroupContactUpsert {
  location_id: string;
  contact_id: string;
  jid: string;
  group_name?: string | null;
  tags?: string[] | null;
  member_count?: number | null;
}

/** Upsert em lote por (location_id, contact_id). Marca is_archived=false + last_synced_at=now. */
export async function upsertGroupContacts(
  rows: GroupContactUpsert[],
): Promise<{ ok: boolean; error?: string }> {
  if (!rows.length) return { ok: true };
  const db = createAdminClient();
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({
    location_id: r.location_id,
    contact_id: r.contact_id,
    jid: r.jid,
    group_name: r.group_name ?? null,
    tags: r.tags ?? null,
    member_count: r.member_count ?? null,
    is_archived: false,
    last_synced_at: now,
  }));
  const { error } = await db
    .from("group_contacts")
    .upsert(payload, { onConflict: "location_id,contact_id" });
  if (error) {
    console.warn("[group-contacts.repo] upsert falhou:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Lista os grupos ativos (não-arquivados) de uma location, ordenados por nome. */
export async function listActiveGroupContacts(locationId: string): Promise<GroupContactRow[]> {
  if (!locationId) return [];
  const db = createAdminClient();
  const { data, error } = await db
    .from("group_contacts")
    .select("*")
    .eq("location_id", locationId)
    .eq("is_archived", false)
    .order("group_name", { ascending: true });
  if (error) {
    console.warn("[group-contacts.repo] list falhou:", error.message);
    return [];
  }
  return (data || []) as GroupContactRow[];
}

/** Marca is_archived=true os grupos ativos que NÃO estão no keep set (sumiram do sync). */
export async function archiveMissingGroupContacts(
  locationId: string,
  keepContactIds: string[],
): Promise<void> {
  if (!locationId) return;
  const db = createAdminClient();
  let q = db
    .from("group_contacts")
    .update({ is_archived: true })
    .eq("location_id", locationId)
    .eq("is_archived", false);
  // GHL ids são alfanuméricos (sem vírgula/parênteses) → seguro interpolar.
  if (keepContactIds.length) {
    q = q.not("contact_id", "in", `(${keepContactIds.join(",")})`);
  }
  const { error } = await q;
  if (error) console.warn("[group-contacts.repo] archive falhou:", error.message);
}

/** Frescor do cache: nº de ativos + o last_synced_at mais recente (pra decidir re-sync). */
export async function getGroupContactsFreshness(
  locationId: string,
): Promise<{ count: number; maxLastSynced: string | null }> {
  if (!locationId) return { count: 0, maxLastSynced: null };
  const db = createAdminClient();
  const { data, error, count } = await db
    .from("group_contacts")
    .select("last_synced_at", { count: "exact" })
    .eq("location_id", locationId)
    .eq("is_archived", false)
    .order("last_synced_at", { ascending: false })
    .limit(1);
  if (error) {
    console.warn("[group-contacts.repo] freshness falhou:", error.message);
    return { count: 0, maxLastSynced: null };
  }
  return { count: count ?? 0, maxLastSynced: data?.[0]?.last_synced_at ?? null };
}
