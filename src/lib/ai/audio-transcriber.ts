import OpenAI, { toFile } from "openai";

const SUPPORTED_FORMATS = ["ogg", "mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB (limite Whisper)

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,
    maxRetries: 1,
  });
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase() || "";
    return ext;
  } catch {
    return "";
  }
}

function getExtensionFromMime(mime: string): string {
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
  };
  return map[mime.toLowerCase()] || "";
}

export async function transcribeAudioFromUrl(
  audioUrl: string,
  mimeType?: string
): Promise<{ text: string; duration_ms: number } | null> {
  const startTime = Date.now();

  try {
    let ext = getExtensionFromUrl(audioUrl);
    if (!SUPPORTED_FORMATS.includes(ext) && mimeType) {
      ext = getExtensionFromMime(mimeType);
    }
    if (!SUPPORTED_FORMATS.includes(ext)) {
      ext = "ogg";
    }

    const response = await fetch(audioUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      console.error(`[Audio] Fetch failed: ${response.status} ${audioUrl}`);
      return null;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
      console.error(`[Audio] File too large: ${contentLength} bytes`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 100) {
      console.error("[Audio] File too small, likely empty");
      return null;
    }

    const file = await toFile(buffer, `audio.${ext}`, {
      type: mimeType || `audio/${ext}`,
    });

    const transcription = await getOpenAIClient().audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "pt",
    });

    const text = transcription.text?.trim();
    if (!text) {
      console.log("[Audio] Transcription returned empty text");
      return null;
    }

    console.log(`[Audio] Transcribed ${buffer.length} bytes in ${Date.now() - startTime}ms: "${text.substring(0, 80)}..."`);

    return { text, duration_ms: Date.now() - startTime };
  } catch (error) {
    console.error("[Audio] Transcription error:", error);
    return null;
  }
}

export function isAudioMessage(messageType?: string, attachments?: unknown[]): boolean {
  if (messageType) {
    const mt = messageType.toUpperCase();
    if (mt.includes("VOICE") || mt.includes("AUDIO") || mt.includes("PTT")) return true;
  }
  if (attachments && attachments.length > 0) {
    return attachments.some((att) => {
      const a = att as Record<string, unknown>;
      const mime = (a.contentType || a.mime_type || a.mimeType || "") as string;
      return mime.startsWith("audio/") || mime === "video/mp4";
    });
  }
  return false;
}

export function extractAudioUrl(body: Record<string, unknown>): {
  url: string;
  mimeType?: string;
} | null {
  // 1. attachments array (formato padrao GHL)
  const attachments = (body.attachments || body.Attachments) as unknown[];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      const a = att as Record<string, unknown>;
      const mime = (a.contentType || a.mime_type || a.mimeType || "") as string;
      const url = (a.url || a.mediaUrl || a.file_url) as string;
      if (url && (mime.startsWith("audio/") || mime === "video/mp4" || mime.includes("ogg"))) {
        return { url, mimeType: mime };
      }
    }
  }

  // 2. mediaUrl direto (algumas integracoes GHL)
  const mediaUrl = (body.mediaUrl || body.media_url || body.mediaURL) as string;
  if (mediaUrl) {
    const ext = getExtensionFromUrl(mediaUrl);
    if (SUPPORTED_FORMATS.includes(ext) || (body.messageType as string)?.toUpperCase().includes("VOICE")) {
      return { url: mediaUrl };
    }
  }

  // 3. customData com audio (n8n style)
  const customData = body.customData as Record<string, unknown> | undefined;
  if (customData) {
    const audioData = (customData.audio_url || customData.audioUrl || customData.media_url) as string;
    if (audioData) return { url: audioData };
  }

  return null;
}
