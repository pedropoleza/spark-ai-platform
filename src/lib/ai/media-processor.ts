import type { MediaAttachment } from "./media-extractor";
import { isImageMime, isDocMime } from "./media-extractor";

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

  try {
    const head = await fetch(att.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });

    if (head.ok) {
      const size = head.headers.get("content-length");
      if (size && parseInt(size) > MAX_IMAGE_SIZE) {
        result.error = "imagem muito grande para processar";
        return result;
      }
      return result;
    }

    // URL não acessível publicamente — baixar e converter para base64
    console.log(`[Media] Image HEAD failed (${head.status}), downloading for base64...`);
  } catch {
    console.log("[Media] Image HEAD timeout, downloading for base64...");
  }

  const downloaded = await downloadBuffer(att.url, 5 * 1024 * 1024);
  if (!downloaded) {
    result.error = "imagem indisponivel";
    return result;
  }

  const mime = att.contentType || downloaded.contentType || "image/jpeg";
  result.base64DataUri = `data:${mime};base64,${downloaded.buffer.toString("base64")}`;
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse");
    const pdfData = await pdfParse(downloaded.buffer);
    const text = (pdfData.text || "").trim();
    if (!text) {
      result.error = "PDF sem texto extraivel (pode ser imagem escaneada)";
      return result;
    }
    result.extractedText = text.substring(0, MAX_EXTRACTED_TEXT);
    if (text.length > MAX_EXTRACTED_TEXT) {
      result.extractedText += "\n[...documento truncado]";
    }
    console.log(`[Media] PDF extracted ${text.length} chars from "${att.fileName || "document.pdf"}"`);
  } catch (err) {
    console.error("[Media] PDF parse error:", err instanceof Error ? err.message : err);
    result.error = "erro ao ler PDF";
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
