export interface MediaAttachment {
  url: string;
  contentType: string;
  fileName?: string;
}

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"];
const DOC_MIMES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
  "application/csv",
  // Excel
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];
const SUPPORTED_MIMES = [...IMAGE_MIMES, ...DOC_MIMES];

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"];
const DOC_EXTS = [".pdf", ".doc", ".docx", ".txt", ".csv", ".xlsx", ".xls"];

function isSupportedMime(mime: string): boolean {
  const m = mime.toLowerCase().split(";")[0].trim();
  return SUPPORTED_MIMES.includes(m);
}

function isAudioMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("audio/") || mime.toLowerCase().includes("ogg");
}

function looksLikeImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return IMAGE_EXTS.some((ext) => lower.includes(ext));
}

function looksLikeDocUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return DOC_EXTS.some((ext) => lower.includes(ext));
}

function guessContentType(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes(".pdf")) return "application/pdf";
  if (lower.includes(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.includes(".doc")) return "application/msword";
  if (lower.includes(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.includes(".xls")) return "application/vnd.ms-excel";
  if (lower.includes(".txt")) return "text/plain";
  if (lower.includes(".csv")) return "text/csv";
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Extrai attachments de imagem e documento do payload GHL.
 * Ignora audio (tratado separadamente pelo audio-transcriber).
 */
export function extractMediaAttachments(body: Record<string, unknown>): MediaAttachment[] {
  const results: MediaAttachment[] = [];
  const seenUrls = new Set<string>();

  const add = (url: string, contentType: string, fileName?: string) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    results.push({ url, contentType, fileName });
  };

  // 1. attachments array
  const attachments = (body.attachments || body.Attachments) as unknown[];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (typeof att === "string") {
        if (looksLikeImageUrl(att) || looksLikeDocUrl(att)) {
          add(att, guessContentType(att));
        }
        continue;
      }
      const a = att as Record<string, unknown>;
      const mime = String(a.contentType || a.mime_type || a.mimeType || "").toLowerCase().split(";")[0].trim();
      const url = String(a.url || a.mediaUrl || a.file_url || a.link || "");
      const name = String(a.fileName || a.file_name || a.name || "");
      if (!url || !url.startsWith("http")) continue;
      if (isAudioMime(mime)) continue;
      if (isSupportedMime(mime)) {
        add(url, mime, name || undefined);
      } else if (!mime && (looksLikeImageUrl(url) || looksLikeDocUrl(url))) {
        add(url, guessContentType(url), name || undefined);
      }
    }
  }

  // 2. mediaUrl direto
  const mediaUrl = String(body.mediaUrl || body.media_url || body.mediaURL || "");
  const mediaContentType = String(body.contentType || "").toLowerCase().split(";")[0].trim();
  if (mediaUrl && mediaUrl.startsWith("http")) {
    if (isSupportedMime(mediaContentType)) {
      add(mediaUrl, mediaContentType);
    } else if (looksLikeImageUrl(mediaUrl) || looksLikeDocUrl(mediaUrl)) {
      add(mediaUrl, guessContentType(mediaUrl));
    }
  }

  // 3. body.body como URL de imagem
  const bodyText = String(body.body || "");
  if (bodyText.startsWith("http") && looksLikeImageUrl(bodyText) && !seenUrls.has(bodyText)) {
    add(bodyText, guessContentType(bodyText));
  }

  return results;
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.includes(mime.toLowerCase().split(";")[0].trim());
}

export function isDocMime(mime: string): boolean {
  return DOC_MIMES.includes(mime.toLowerCase().split(";")[0].trim());
}
