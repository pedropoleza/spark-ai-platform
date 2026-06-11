import type { MediaAttachment } from "./media-extractor";
import { isImageMime, isDocMime } from "./media-extractor";
import { reportError } from "@/lib/admin-signals/report-error";

const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_DOC_SIZE = 10 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 8000;
const DOWNLOAD_TIMEOUT = 15000;

export interface ProcessedMedia {
  type: "image" | "document";
  url: string;
  contentType: string;
  fileName?: string;
  extractedText?: string;
  base64DataUri?: string;
  error?: string;
}

async function downloadBuffer(url: string, maxSize: number): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    // SSRF guard (fix P0 review pré-launch 2026-06-10): a URL vem do attachment
    // do webhook inbound LEAD-FACING, que é fail-open em prod (GHL não manda
    // HMAC efetivo). Sem isto, um webhook forjado com url=http://169.254.169.254/...
    // faria o servidor ler metadata/serviços internos. O gêmeo audio-transcriber.ts
    // (e o input-parser do SparkBot) já aplicam o mesmo guard — esta era a regressão.
    const { validateExternalUrl } = await import("@/lib/utils/url-allowlist");
    const urlVal = validateExternalUrl(url);
    if (!urlVal.ok) {
      console.error(`[Media] SSRF guard rejected URL: ${urlVal.reason} (${url.substring(0, 60)})`);
      return null;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
    if (!res.ok) {
      console.error(`[Media] Download failed: ${res.status} ${url.substring(0, 80)}`);
      return null;
    }
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > maxSize) {
      console.warn(`[Media] File too large: ${contentLength} bytes (max ${maxSize})`);
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxSize) return null;
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get("content-type") || "",
    };
  } catch (err) {
    console.error(`[Media] Download error:`, err instanceof Error ? err.message : err);
    // Sweep F49 2026-06-05: não baixou a mídia → anexo do lead ignorado (bot
    // responde como se nada tivesse vindo). Silencioso (retorna null).
    reportError({ title: "Media processor: download da mídia falhou", feature: "media-processor", severity: "medium", error: err });
    return null;
  }
}

async function processImage(att: MediaAttachment): Promise<ProcessedMedia> {
  const result: ProcessedMedia = {
    type: "image",
    url: att.url,
    contentType: att.contentType,
    fileName: att.fileName,
  };

  // Sempre baixar e converter para base64 — URLs do GHL sao
  // temporarias/assinadas e o OpenAI nao consegue acessar diretamente.
  const downloaded = await downloadBuffer(att.url, MAX_IMAGE_SIZE);
  if (!downloaded) {
    result.error = "imagem indisponivel ou muito grande";
    return result;
  }

  const mime = att.contentType || downloaded.contentType || "image/jpeg";
  const cleanMime = mime.split(";")[0].trim();
  result.base64DataUri = `data:${cleanMime};base64,${downloaded.buffer.toString("base64")}`;
  console.log(`[Media] Image downloaded and converted to base64: ${downloaded.buffer.length} bytes (${cleanMime})`);
  return result;
}

async function processPdf(att: MediaAttachment): Promise<ProcessedMedia> {
  const result: ProcessedMedia = {
    type: "document",
    url: att.url,
    contentType: att.contentType,
    fileName: att.fileName,
  };

  const downloaded = await downloadBuffer(att.url, MAX_DOC_SIZE);
  if (!downloaded) {
    result.error = "documento nao pode ser baixado";
    return result;
  }

  console.log(`[Media] PDF downloaded: ${downloaded.buffer.length} bytes, parsing with unpdf...`);

  try {
    const { extractText } = await import("unpdf");
    const { text, totalPages } = await extractText(
      new Uint8Array(downloaded.buffer),
      { mergePages: true }
    );
    const cleaned = (text || "").trim();
    if (!cleaned) {
      console.warn("[Media] PDF extraction returned empty text");
      result.error = "PDF sem texto extraivel (pode ser imagem escaneada)";
      return result;
    }
    result.extractedText = cleaned.substring(0, MAX_EXTRACTED_TEXT);
    if (cleaned.length > MAX_EXTRACTED_TEXT) {
      result.extractedText += "\n[...documento truncado]";
    }
    console.log(`[Media] PDF extracted ${cleaned.length} chars (${totalPages} pages) from "${att.fileName || "document.pdf"}": "${cleaned.substring(0, 80)}..."`);
  } catch (err) {
    console.error("[Media] PDF parse error:", err instanceof Error ? err.message : err);
    result.error = "erro ao ler PDF";
    // Sweep F49 2026-06-05: extração de PDF falhou (semi-visível — bot avisa que
    // não leu). Low: pra medir taxa de falha de extração.
    reportError({ title: "Media processor: leitura de PDF falhou", feature: "media-processor", severity: "low", error: err });
  }

  return result;
}

async function processDocx(att: MediaAttachment): Promise<ProcessedMedia> {
  const result: ProcessedMedia = {
    type: "document",
    url: att.url,
    contentType: att.contentType,
    fileName: att.fileName,
  };

  const downloaded = await downloadBuffer(att.url, MAX_DOC_SIZE);
  if (!downloaded) {
    result.error = "documento nao pode ser baixado";
    return result;
  }

  try {
    const mammoth = await import("mammoth");
    const mammothResult = await mammoth.extractRawText({ buffer: downloaded.buffer });
    const text = (mammothResult.value || "").trim();
    if (!text) {
      result.error = "documento sem texto extraivel";
      return result;
    }
    result.extractedText = text.substring(0, MAX_EXTRACTED_TEXT);
    if (text.length > MAX_EXTRACTED_TEXT) {
      result.extractedText += "\n[...documento truncado]";
    }
    console.log(`[Media] DOCX extracted ${text.length} chars from "${att.fileName || "document.docx"}"`);
  } catch (err) {
    console.error("[Media] DOCX parse error:", err instanceof Error ? err.message : err);
    result.error = "erro ao ler documento Word";
    // Sweep F49 2026-06-05: extração de DOCX falhou (semi-visível). Low.
    reportError({ title: "Media processor: leitura de DOCX falhou", feature: "media-processor", severity: "low", error: err });
  }

  return result;
}

async function processPlainText(att: MediaAttachment): Promise<ProcessedMedia> {
  const result: ProcessedMedia = {
    type: "document",
    url: att.url,
    contentType: att.contentType,
    fileName: att.fileName,
  };

  const downloaded = await downloadBuffer(att.url, MAX_DOC_SIZE);
  if (!downloaded) {
    result.error = "arquivo nao pode ser baixado";
    return result;
  }

  const text = downloaded.buffer.toString("utf-8").trim();
  if (!text) {
    result.error = "arquivo vazio";
    return result;
  }
  result.extractedText = text.substring(0, MAX_EXTRACTED_TEXT);
  if (text.length > MAX_EXTRACTED_TEXT) {
    result.extractedText += "\n[...arquivo truncado]";
  }
  return result;
}

export async function processMediaAttachments(
  attachments: MediaAttachment[]
): Promise<ProcessedMedia[]> {
  const startTime = Date.now();
  const results: ProcessedMedia[] = [];
  const MAX_IMAGES = 4;
  let imageCount = 0;

  for (const att of attachments) {
    if (Date.now() - startTime > 25000) {
      console.warn(`[Media] Processing budget exceeded (25s), skipping remaining ${attachments.length - results.length} attachments`);
      break;
    }

    const mime = att.contentType.toLowerCase().split(";")[0].trim();

    if (isImageMime(mime)) {
      if (imageCount >= MAX_IMAGES) {
        results.push({
          type: "image",
          url: att.url,
          contentType: att.contentType,
          error: `limite de ${MAX_IMAGES} imagens atingido`,
        });
        continue;
      }
      results.push(await processImage(att));
      imageCount++;
    } else if (mime === "application/pdf") {
      results.push(await processPdf(att));
    } else if (
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mime === "application/msword"
    ) {
      if (mime === "application/msword") {
        results.push({
          type: "document",
          url: att.url,
          contentType: att.contentType,
          fileName: att.fileName,
          error: "formato .doc antigo nao suportado — peca ao contato enviar como PDF",
        });
      } else {
        results.push(await processDocx(att));
      }
    } else if (isDocMime(mime)) {
      results.push(await processPlainText(att));
    } else {
      results.push({
        type: "document",
        url: att.url,
        contentType: att.contentType,
        fileName: att.fileName,
        error: `formato nao suportado: ${mime}`,
      });
    }
  }

  console.log(`[Media] Processed ${results.length} attachments in ${Date.now() - startTime}ms`);
  return results;
}
