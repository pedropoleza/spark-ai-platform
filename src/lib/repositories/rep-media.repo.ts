/**
 * Repositório da biblioteca de mídia do rep (rep_media, H46/F4 — migration 00122).
 * Não lança: loga e devolve fallback. service_role.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type RepMediaKind = "audio" | "image" | "document";

export interface RepMediaRow {
  id: string;
  rep_id: string;
  hub_location_id: string | null;
  storage_path: string;
  mime_type: string;
  media_kind: RepMediaKind;
  size_bytes: number | null;
  original_name: string | null;
  transcription: string | null;
  caption_text: string | null;
  short_label: string | null;
  source: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface RepMediaInsert {
  rep_id: string;
  hub_location_id?: string | null;
  storage_path: string;
  mime_type: string;
  media_kind: RepMediaKind;
  size_bytes?: number | null;
  original_name?: string | null;
  transcription?: string | null;
  caption_text?: string | null;
  short_label?: string | null;
  source?: "whatsapp" | "web";
}

export async function insertRepMedia(row: RepMediaInsert): Promise<{ ok: boolean; id?: string; error?: string }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("rep_media")
    .insert({ ...row, source: row.source ?? "whatsapp" })
    .select("id")
    .single();
  if (error) {
    console.warn("[rep-media.repo] insert falhou:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data.id as string };
}

/** Últimas mídias do rep (mais recentes primeiro). */
export async function listRecentRepMedia(
  repId: string,
  opts: { kind?: RepMediaKind; limit?: number } = {},
): Promise<RepMediaRow[]> {
  if (!repId) return [];
  const db = createAdminClient();
  let q = db
    .from("rep_media")
    .select("*")
    .eq("rep_id", repId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 8);
  if (opts.kind) q = q.eq("media_kind", opts.kind);
  const { data, error } = await q;
  if (error) {
    console.warn("[rep-media.repo] list falhou:", error.message);
    return [];
  }
  return (data || []) as RepMediaRow[];
}

/** Busca 1 asset garantindo que é do rep (anti-IDOR). */
export async function getRepMediaById(repId: string, mediaId: string): Promise<RepMediaRow | null> {
  if (!repId || !mediaId) return null;
  const db = createAdminClient();
  const { data, error } = await db
    .from("rep_media")
    .select("*")
    .eq("id", mediaId)
    .eq("rep_id", repId)
    .maybeSingle();
  if (error) return null;
  return (data as RepMediaRow) || null;
}

/** Carimba last_used_at (best-effort). */
export async function touchRepMediaUsed(mediaId: string): Promise<void> {
  if (!mediaId) return;
  try {
    const db = createAdminClient();
    await db.from("rep_media").update({ last_used_at: new Date().toISOString() }).eq("id", mediaId);
  } catch {
    // best-effort
  }
}
