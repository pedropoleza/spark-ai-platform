/**
 * Captura de mídia do rep → biblioteca rep_media (H46/F4).
 *
 * O rep manda imagem/documento pro SparkBot; guardamos o ARQUIVO (não só a
 * transcrição/descrição) como ativo reutilizável pra disparar nos grupos depois.
 * Imagem: bytes vêm do base64 do repInput (sem re-fetch). Documento: re-fetch da
 * URL do attachment (SSRF-guarded, fresco no inbound) porque o repInput só carrega
 * o texto extraído, não os bytes. ÁUDIO fica deferido (decisão Pedro: .wav exige
 * transcode .ogg→.wav — ffmpeg na Vercel é decisão aberta).
 *
 * Best-effort/fail-soft: nunca quebra o turno. Reusa o bucket agent-media (00116).
 */
import type { RepInput } from "@/types/account-assistant";
import type { MediaAttachment } from "@/lib/ai/media-extractor";
import { createAdminClient } from "@/lib/supabase/admin";
import { insertRepMedia } from "@/lib/repositories/rep-media.repo";

const BUCKET = "agent-media";
const MAX_BYTES = 20 * 1024 * 1024; // 20MB (bucket 25, WhatsApp ~16)

function extFromMime(mime: string, fallbackName?: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("pdf")) return "pdf";
  const dot = fallbackName ? fallbackName.lastIndexOf(".") : -1;
  if (fallbackName && dot > 0) return fallbackName.slice(dot + 1).toLowerCase().slice(0, 5);
  return "bin";
}

function dataUriToBuffer(dataUri: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec((dataUri || "").trim());
  if (!m) return null;
  try {
    return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
  } catch {
    return null;
  }
}

async function fetchBytes(url: string, mime?: string): Promise<{ mime: string; bytes: Buffer } | null> {
  try {
    const { validateExternalUrl } = await import("@/lib/utils/url-allowlist");
    const v = validateExternalUrl(url);
    if (!v.ok) {
      console.warn("[rep-media] URL bloqueada (SSRF):", v.reason);
      return null;
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    return { mime: mime || r.headers.get("content-type") || "application/octet-stream", bytes };
  } catch (e) {
    console.warn("[rep-media] fetch falhou:", e instanceof Error ? e.message.slice(0, 120) : e);
    return null;
  }
}

async function uploadAndRegister(args: {
  repId: string;
  hubLocationId: string;
  kind: "image" | "document";
  bytes: Buffer;
  mime: string;
  originalName?: string | null;
  caption?: string | null;
  shortLabel: string;
  source: "whatsapp" | "web";
}): Promise<void> {
  if (args.bytes.length === 0 || args.bytes.length > MAX_BYTES) {
    console.warn(`[rep-media] tamanho fora do limite (${args.bytes.length}B) — não guardado.`);
    return;
  }
  const supabase = createAdminClient();
  const path = `rep-media/${args.repId}/${crypto.randomUUID()}.${extFromMime(args.mime, args.originalName || undefined)}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, args.bytes, { contentType: args.mime, upsert: false });
  if (upErr) {
    console.warn("[rep-media] upload falhou:", upErr.message);
    return;
  }
  await insertRepMedia({
    rep_id: args.repId,
    hub_location_id: args.hubLocationId,
    storage_path: path,
    mime_type: args.mime,
    media_kind: args.kind,
    size_bytes: args.bytes.length,
    original_name: args.originalName ?? null,
    caption_text: args.caption ?? null,
    short_label: args.shortLabel,
    source: args.source,
  });
}

/**
 * Persiste a mídia do turno na biblioteca do rep. Best-effort. SÓ imagem e
 * documento por agora (áudio deferido). Chamado pós-parse no webhook (fire-and-forget).
 */
export async function persistRepMedia(args: {
  repId: string;
  hubLocationId: string;
  repInput: RepInput;
  mediaAttachments: MediaAttachment[];
  source?: "whatsapp" | "web";
}): Promise<void> {
  const source = args.source ?? "whatsapp";
  const ri = args.repInput;
  try {
    if (ri.kind === "image") {
      const buf = dataUriToBuffer(ri.base64_data_uri);
      if (!buf) return;
      const kb = Math.round(buf.bytes.length / 1024);
      await uploadAndRegister({
        repId: args.repId,
        hubLocationId: args.hubLocationId,
        kind: "image",
        bytes: buf.bytes,
        mime: buf.mime,
        originalName: ri.filename ?? null,
        caption: ri.caption ?? null,
        shortLabel: `Imagem ${ri.filename || "sem nome"} (${kb} KB)`,
        source,
      });
    } else if (ri.kind === "document") {
      const att = args.mediaAttachments.find(
        (a) =>
          /pdf|word|document|sheet|excel|csv|text|octet-stream/i.test(a.contentType || "") ||
          /\.(pdf|docx?|txt|csv|xlsx?)$/i.test(a.fileName || a.url || ""),
      );
      if (!att?.url) return; // só temos o texto extraído, não os bytes originais
      const fetched = await fetchBytes(att.url, att.contentType);
      if (!fetched) return;
      const kb = Math.round(fetched.bytes.length / 1024);
      const isPdf = /pdf/i.test(fetched.mime) || /\.pdf$/i.test(ri.filename || "");
      await uploadAndRegister({
        repId: args.repId,
        hubLocationId: args.hubLocationId,
        kind: "document",
        bytes: fetched.bytes,
        mime: fetched.mime,
        originalName: ri.filename ?? null,
        caption: ri.caption || (ri.extracted_text ? ri.extracted_text.slice(0, 200) : null),
        shortLabel: `${isPdf ? "PDF" : "Documento"} ${ri.filename || "sem nome"} (${kb} KB)`,
        source,
      });
    }
    // audio: deferido (decisão Pedro sobre transcode .wav).
  } catch (err) {
    console.warn("[rep-media] persist falhou (fail-soft):", err instanceof Error ? err.message.slice(0, 150) : err);
  }
}
