import OpenAI, { toFile } from "openai";

const SUPPORTED_FORMATS = ["ogg", "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "opus"];
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function getOpenAIClient(customApiKey?: string) {
  return new OpenAI({
    apiKey: customApiKey || process.env.OPENAI_API_KEY,
    timeout: 60000,
    maxRetries: 1,
  });
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase() || "";
    if (SUPPORTED_FORMATS.includes(ext)) return ext;
    if (url.includes("ogg")) return "ogg";
    if (url.includes("opus")) return "ogg";
    return "";
  } catch {
    return "";
  }
}

function getExtensionFromMime(mime: string): string {
  const m = mime.toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "video/mp4": "mp4",
    "audio/opus": "ogg",
    "audio/ogg; codecs=opus": "ogg",
  };
  return map[m] || (m.startsWith("audio/") ? "ogg" : "");
}

export interface TranscriptionResult {
  text: string;
  duration_ms: number;     // wall-clock do download+transcribe
  audio_seconds: number;   // duração REAL do áudio (pra billing Whisper)
  model: string;
}

export type TranscriptionFailureCode =
  | "fetch_failed"
  | "too_small"
  | "too_large"
  | "empty_text"
  | "quota_exceeded"
  | "invalid_key"
  | "rate_limited"
  | "unknown";

/**
 * Versão verbose: retorna union estruturado com causa do erro.
 * Implementação real (substitui o null-return). O legacy
 * `transcribeAudioFromUrl` (abaixo) é wrapper que joga o erro fora.
 */
export async function transcribeAudioFromUrlVerbose(
  audioUrl: string,
  mimeType?: string,
  /** Opcional: BYO OpenAI key da location (skip platform billing). */
  customApiKey?: string,
): Promise<
  | { ok: true; result: TranscriptionResult }
  | { ok: false; code: TranscriptionFailureCode; message: string }
> {
  const startTime = Date.now();
  console.log(`[Audio] Starting transcription: ${audioUrl.substring(0, 120)}... (mime: ${mimeType || "unknown"})`);

  let ext = getExtensionFromUrl(audioUrl);
  if (!SUPPORTED_FORMATS.includes(ext) && mimeType) {
    ext = getExtensionFromMime(mimeType);
  }
  if (!SUPPORTED_FORMATS.includes(ext)) {
    ext = "ogg";
  }

  let buffer: Buffer;
  let contentType = "";
  try {
    // SSRF guard (fix CRITICAL stress test 2026-05-03)
    const { validateExternalUrl } = await import("@/lib/utils/url-allowlist");
    const urlVal = validateExternalUrl(audioUrl);
    if (!urlVal.ok) {
      console.error(`[Audio] SSRF guard rejected URL: ${urlVal.reason}`);
      return { ok: false, code: "fetch_failed", message: `URL blocked: ${urlVal.reason}` };
    }
    const response = await fetch(audioUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const m = `Fetch failed: ${response.status} ${response.statusText}`;
      console.error(`[Audio] ${m}`);
      return { ok: false, code: "fetch_failed", message: m };
    }
    contentType = response.headers.get("content-type") || "";
    if (contentType && !ext) ext = getExtensionFromMime(contentType) || "ogg";
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    console.log(`[Audio] Downloaded ${buffer.length} bytes (content-type: ${contentType})`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[Audio] Fetch threw: ${m}`);
    return { ok: false, code: "fetch_failed", message: m };
  }

  if (buffer.length < 100) {
    return { ok: false, code: "too_small", message: `${buffer.length} bytes` };
  }
  if (buffer.length > MAX_FILE_SIZE) {
    return { ok: false, code: "too_large", message: `${buffer.length} bytes` };
  }

  try {
    const file = await toFile(buffer, `audio.${ext}`, {
      type: mimeType || contentType || `audio/${ext}`,
    });
    const transcription = await getOpenAIClient(customApiKey).audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "pt",
      response_format: "verbose_json",
    }) as { text?: string; duration?: number };

    const text = transcription.text?.trim();
    if (!text) {
      return { ok: false, code: "empty_text", message: "Whisper retornou texto vazio" };
    }
    const audioSeconds = typeof transcription.duration === "number" ? transcription.duration : 0;
    console.log(`[Audio] Transcribed ${audioSeconds.toFixed(1)}s in ${Date.now() - startTime}ms: "${text.substring(0, 100)}"`);
    return {
      ok: true,
      result: { text, duration_ms: Date.now() - startTime, audio_seconds: audioSeconds, model: "whisper-1" },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("429") && msg.toLowerCase().includes("quota")) {
      console.error("[Audio] ⚠️  OPENAI QUOTA EXCEEDED — recarregar créditos:", msg);
      return { ok: false, code: "quota_exceeded", message: msg.slice(0, 500) };
    }
    if (msg.includes("429")) {
      return { ok: false, code: "rate_limited", message: msg.slice(0, 500) };
    }
    if (msg.includes("401") || msg.toLowerCase().includes("invalid api key")) {
      console.error("[Audio] ⚠️  OPENAI KEY INVÁLIDA:", msg);
      return { ok: false, code: "invalid_key", message: msg.slice(0, 500) };
    }
    console.error("[Audio] Transcription error:", msg);
    return { ok: false, code: "unknown", message: msg.slice(0, 500) };
  }
}

/**
 * Wrapper legacy — retorna null em qualquer falha. Mantido por compat;
 * novo código deve usar transcribeAudioFromUrlVerbose.
 */
export async function transcribeAudioFromUrl(
  audioUrl: string,
  mimeType?: string
): Promise<TranscriptionResult | null> {
  const r = await transcribeAudioFromUrlVerbose(audioUrl, mimeType);
  return r.ok ? r.result : null;
}

/**
 * Extrai URL de audio do payload do webhook GHL.
 * O GHL envia audio em formatos variados dependendo do canal (WhatsApp, SMS, etc).
 */
export function extractAudioUrl(body: Record<string, unknown>): {
  url: string;
  mimeType?: string;
} | null {
  // 1. attachments como array de objetos { url, contentType }
  const attachments = (body.attachments || body.Attachments) as unknown[];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (typeof att === "string") {
        // Attachment pode ser URL direta (string)
        if (isAudioUrl(att)) return { url: att };
        continue;
      }
      const a = att as Record<string, unknown>;
      const mime = String(a.contentType || a.mime_type || a.mimeType || "");
      const url = String(a.url || a.mediaUrl || a.file_url || a.link || "");
      if (url && isAudioMime(mime)) {
        return { url, mimeType: mime };
      }
      // Se nao tem mime mas tem URL de audio
      if (url && isAudioUrl(url)) {
        return { url, mimeType: mime || undefined };
      }
    }
  }

  // 2. mediaUrl direto no body
  const mediaUrl = String(body.mediaUrl || body.media_url || body.mediaURL || "");
  if (mediaUrl && (isAudioUrl(mediaUrl) || isAudioMime(String(body.contentType || "")))) {
    return { url: mediaUrl, mimeType: String(body.contentType || "") || undefined };
  }

  // 3. body.body pode ser uma URL de audio (WhatsApp voice no GHL)
  const bodyText = String(body.body || "");
  if (bodyText.startsWith("http") && isAudioUrl(bodyText)) {
    return { url: bodyText };
  }

  // 4. data.audio_data ou data com URL (formato n8n/custom)
  const data = body.data as Record<string, unknown> | undefined;
  if (data) {
    const audioData = String(data.audio_data || data.audio_url || data.mediaUrl || "");
    if (audioData && audioData.startsWith("http")) return { url: audioData };
  }

  // 5. customData com audio
  const customData = body.customData as Record<string, unknown> | undefined;
  if (customData) {
    const audioData = String(customData.audio_url || customData.audioUrl || customData.media_url || "");
    if (audioData && audioData.startsWith("http")) return { url: audioData };
  }

  // 6. messageType indica voice/audio — body pode ter a URL
  const mt = String(body.messageType || body.type || "").toUpperCase();
  if (mt.includes("VOICE") || mt.includes("AUDIO") || mt.includes("PTT")) {
    // Tentar encontrar qualquer URL no body
    if (mediaUrl) return { url: mediaUrl };
    if (bodyText.startsWith("http")) return { url: bodyText };
  }

  return null;
}

function isAudioMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.startsWith("audio/") || m === "video/mp4" || m.includes("ogg") || m.includes("opus");
}

function isAudioUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return SUPPORTED_FORMATS.some(f => lower.includes(`.${f}`)) ||
    lower.includes("ogg") || lower.includes("opus") || lower.includes("voice") ||
    lower.includes("audio") || lower.includes("ptt");
}
