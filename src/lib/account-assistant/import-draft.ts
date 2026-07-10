/**
 * Draft persistente do fluxo planilha→disparo (H49 Onda 2, 2026-07-10).
 *
 * Post-mortem Jussara 03/07: o attachment é POR-TURNO (ctx.attachment) e o fluxo
 * import→preview→disparo é multi-turno por design → a rep reanexou o MESMO .xlsx
 * 12× ("planilha expirou", TTL inventado pelo LLM) e o texto aprovado divergiu no
 * caminho (12 contatos receberam msg errada). Mesmo princípio do orquestrador H41:
 * o fluxo vira um OBJETO PERSISTENTE (task_drafts kind='import_bulk'), não uma
 * lembrança do LLM.
 *
 * O draft guarda: rows parseados da planilha (snapshot ≤500 linhas), os ghl_ids
 * REAIS devolvidos pelo import (pra disparar por ID, sem race de tag) e o último
 * preview (guarda de template: o schedule recusa texto diferente do previewado).
 * Janela de reuso: 24h. Purge natural via cleanup dos drafts (H41).
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** Janela em que um draft de import segue reutilizável sem reanexo. */
export const IMPORT_DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ImportDraftRows {
  filename: string;
  columns: string[];
  total_rows: number;
  active_sheet?: string | null;
  rows: Array<Record<string, unknown>>;
}

export interface ImportedContactRecord {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface ImportDraft extends ImportDraftRows {
  draft_id: string;
  /** Contatos JÁ importados desta planilha (ghl_ids reais do upsert). */
  created?: ImportedContactRecord[];
  imported_at?: string | null;
  /** Guarda de template: textos exibidos no último preview_bulk_message_v2. */
  last_preview?: { templates: string[]; at: string } | null;
  updated_at: string;
}

type MetaShape = Omit<ImportDraft, "draft_id" | "updated_at">;

/** Cria/atualiza o draft aberto do rep com o snapshot da planilha do turno. */
export async function saveImportDraft(
  repId: string,
  locationId: string,
  data: ImportDraftRows,
): Promise<string | null> {
  try {
    const supabase = createAdminClient();
    const existing = await findOpenDraftRow(repId);
    const meta: MetaShape = {
      filename: data.filename,
      columns: data.columns,
      total_rows: data.total_rows,
      active_sheet: data.active_sheet ?? null,
      rows: data.rows,
      // Planilha NOVA zera o estado de import/preview (created/last_preview) —
      // ids antigos não valem pra rows novos.
      created: undefined,
      imported_at: null,
      last_preview: null,
    };
    if (existing) {
      const { error } = await supabase
        .from("task_drafts")
        .update({ title: data.filename, meta, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw error;
      return existing.id;
    }
    const { data: row, error } = await supabase
      .from("task_drafts")
      .insert({
        rep_id: repId,
        location_id: locationId,
        kind: "import_bulk",
        status: "building",
        title: data.filename,
        meta,
      })
      .select("id")
      .single();
    if (error || !row) throw error || new Error("insert sem id");
    return row.id as string;
  } catch (err) {
    console.warn("[import-draft] save falhou (não-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Carrega o draft aberto (≤24h) do rep — fallback quando o turno não tem anexo. */
export async function loadImportDraft(repId: string): Promise<ImportDraft | null> {
  try {
    const row = await findOpenDraftRow(repId);
    if (!row) return null;
    const meta = (row.meta || {}) as Partial<MetaShape>;
    if (!meta.filename || !Array.isArray(meta.rows)) return null;
    return {
      draft_id: row.id,
      filename: meta.filename,
      columns: Array.isArray(meta.columns) ? meta.columns : [],
      total_rows: Number(meta.total_rows) || meta.rows.length,
      active_sheet: meta.active_sheet ?? null,
      rows: meta.rows,
      created: Array.isArray(meta.created) ? meta.created : undefined,
      imported_at: meta.imported_at ?? null,
      last_preview: meta.last_preview ?? null,
      updated_at: row.updated_at,
    };
  } catch (err) {
    console.warn("[import-draft] load falhou (não-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Grava os ghl_ids reais pós-import (habilita disparo por ID, sem tag/race). */
export async function setImportDraftCreated(
  draftId: string,
  created: ImportedContactRecord[],
): Promise<void> {
  await patchMeta(draftId, { created, imported_at: new Date().toISOString() });
}

/** Grava os templates do último preview (guarda anti-drift no schedule). */
export async function setImportDraftPreview(draftId: string, templates: string[]): Promise<void> {
  await patchMeta(draftId, { last_preview: { templates, at: new Date().toISOString() } });
}

// ── internos ────────────────────────────────────────────────────────

async function findOpenDraftRow(
  repId: string,
): Promise<{ id: string; meta: unknown; updated_at: string } | null> {
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - IMPORT_DRAFT_WINDOW_MS).toISOString();
  const { data } = await supabase
    .from("task_drafts")
    .select("id, meta, updated_at")
    .eq("rep_id", repId)
    .eq("kind", "import_bulk")
    .eq("status", "building")
    .gte("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string; meta: unknown; updated_at: string } | null) || null;
}

async function patchMeta(draftId: string, patch: Partial<MetaShape>): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { data: row } = await supabase.from("task_drafts").select("meta").eq("id", draftId).maybeSingle();
    const meta = ((row?.meta as Record<string, unknown>) || {}) as Record<string, unknown>;
    await supabase
      .from("task_drafts")
      .update({ meta: { ...meta, ...patch }, updated_at: new Date().toISOString() })
      .eq("id", draftId);
  } catch (err) {
    console.warn("[import-draft] patch falhou (não-fatal):", err instanceof Error ? err.message : err);
  }
}
