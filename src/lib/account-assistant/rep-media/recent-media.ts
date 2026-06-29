/**
 * "Mídias recentes do rep" no contexto do turno (H46/F4). Espelha o "CONTATO EM
 * CONTEXTO" do H45: o bot lembra dos arquivos que o rep mandou pra poder disparar
 * ("manda aquele PDF no grupo X"). PISTA validável — o media_id é REAL (da rep_media),
 * nunca inventado. Vai no runtime context (user message, não-cacheada — compat H44).
 */
import { listRecentRepMedia, type RepMediaRow } from "@/lib/repositories/rep-media.repo";

export interface RecentMediaItem {
  media_id: string;
  kind: string;
  label: string;
}

function labelFor(r: RepMediaRow): string {
  if (r.short_label) return r.short_label;
  if (r.media_kind === "audio") return `Áudio${r.transcription ? ` — "${r.transcription.slice(0, 60)}"` : ""}`;
  if (r.media_kind === "image") return `Imagem ${r.original_name || ""}`.trim();
  return `Documento ${r.original_name || ""}`.trim();
}

export async function getRecentRepMedia(repId: string, opts: { limit?: number } = {}): Promise<RecentMediaItem[]> {
  const rows = await listRecentRepMedia(repId, { limit: opts.limit ?? 5 });
  return rows.map((r) => ({ media_id: r.id, kind: r.media_kind, label: labelFor(r) }));
}

export function renderRecentMediaBlock(items: RecentMediaItem[]): string {
  if (!items.length) return "";
  const lines = [
    "# MÍDIAS RECENTES DO REP",
    "Arquivos que você recebeu de mim (pra disparar nos grupos, use o media_id EXATO — NUNCA invente):",
  ];
  for (const it of items) lines.push(`- [media_id: ${it.media_id}] ${it.label}`);
  lines.push("Se não tiver certeza de qual mídia o rep quer, pergunte. NUNCA invente um media_id.");
  return lines.join("\n");
}
