/**
 * Tool de biblioteca de mídia do rep (H46/F4). GATED por REP_MEDIA_ENABLED no
 * registry. Lista os arquivos (imagem/áudio/doc) que o rep mandou, pra disparar
 * nos grupos pelo media_id (anti-alucinação: id REAL, nunca inventado).
 */
import type { ToolEntry } from "./types";
import { listRecentRepMedia, type RepMediaKind } from "@/lib/repositories/rep-media.repo";

const listRepMedia: ToolEntry = {
  def: {
    name: "list_rep_media",
    description:
      "Lista os ARQUIVOS (imagem/documento/áudio) que o rep te mandou e estão guardados pra disparar nos grupos. " +
      "Use o media_id daqui (ou das MÍDIAS RECENTES DO REP) ao anexar num group_campaign schedule — NUNCA invente um media_id.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "document", "audio"], description: "Filtra por tipo (opcional)." },
        limit: { type: "number", description: "Quantos retornar (default 10, max 30)." },
      },
    },
  },
  handler: async (ctx, args) => {
    const kindRaw = args.kind ? String(args.kind) : "";
    const kind = (["image", "document", "audio"].includes(kindRaw) ? kindRaw : undefined) as
      | RepMediaKind
      | undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    const rows = await listRecentRepMedia(ctx.rep.id, { kind, limit });
    return {
      status: "ok",
      data: {
        count: rows.length,
        media: rows.map((r) => ({
          media_id: r.id,
          kind: r.media_kind,
          label: r.short_label || r.original_name || r.media_kind,
          created_at: r.created_at,
        })),
        message: rows.length
          ? `Você tem ${rows.length} arquivo(s) guardado(s) — me diz qual disparar e em quais grupos.`
          : "Você ainda não me mandou nenhum arquivo. Manda a imagem/documento aqui que eu guardo pra usar nos grupos.",
      },
    };
  },
};

export const REP_MEDIA_TOOLS: ToolEntry[] = [listRepMedia];
