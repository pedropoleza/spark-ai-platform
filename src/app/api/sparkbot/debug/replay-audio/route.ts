/**
 * POST /api/sparkbot/debug/replay-audio
 *
 * Rota TEMPORÁRIA pra debug do problema de transcrição WhatsApp.
 * Aceita { audioUrl } ou { debugRowId } e roda transcribeAudioFromUrl
 * direto. Retorna resultado completo (status fetch, tamanho, transcribe text,
 * erro). Permite iterar sem precisar Pedro mandar áudio novo.
 *
 * Auth: header `x-debug-key` deve bater com env var DEBUG_REPLAY_KEY.
 *
 * Remove esse arquivo quando o problema do áudio Stevo+WhatsApp API estiver
 * resolvido.
 */

import { NextRequest, NextResponse } from "next/server";
import { transcribeAudioFromUrl } from "@/lib/ai/audio-transcriber";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Auth — chave hardcoded provisória (rota debug temporária, será removida).
  // Aceita header "x-debug-key" OU query param ?key=
  const HARDCODED_KEY = "dbg_faf33648d11fbbe4334247e425a530a5";
  const headerKey = req.headers.get("x-debug-key");
  const queryKey = req.nextUrl.searchParams.get("key");
  if (headerKey !== HARDCODED_KEY && queryKey !== HARDCODED_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let audioUrl = String(body.audioUrl || "");
  const mimeType = String(body.mimeType || "audio/ogg");
  const debugRowId = String(body.debugRowId || "");

  // Se passou debugRowId, busca audio_url da tabela
  if (debugRowId && !audioUrl) {
    const supabase = createAdminClient();
    const { data: row } = await supabase
      .from("sparkbot_webhook_debug")
      .select("audio_url_extracted, body_raw")
      .eq("id", debugRowId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ error: "debug_row_not_found" }, { status: 404 });
    }
    audioUrl = row.audio_url_extracted || "";
    if (!audioUrl) {
      return NextResponse.json({ error: "no_audio_url_in_debug_row", body_raw: row.body_raw }, { status: 400 });
    }
  }

  if (!audioUrl) {
    return NextResponse.json({ error: "missing_audioUrl_or_debugRowId" }, { status: 400 });
  }

  const stages: Record<string, unknown> = {
    audioUrl,
    mimeType,
  };

  // 1. Fetch direto pra checar se Vercel acessa
  try {
    const headStart = Date.now();
    const headRes = await fetch(audioUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(15000),
    });
    stages.head = {
      ok: headRes.ok,
      status: headRes.status,
      contentType: headRes.headers.get("content-type"),
      contentLength: headRes.headers.get("content-length"),
      duration_ms: Date.now() - headStart,
    };
  } catch (err) {
    stages.head = { error: err instanceof Error ? err.message : String(err) };
  }

  // 2. Fetch GET pra confirmar que body é fetchable
  try {
    const getStart = Date.now();
    const getRes = await fetch(audioUrl, { signal: AbortSignal.timeout(20000) });
    if (!getRes.ok) {
      stages.get = { ok: false, status: getRes.status, statusText: getRes.statusText };
    } else {
      const buf = await getRes.arrayBuffer();
      stages.get = {
        ok: true,
        status: getRes.status,
        contentType: getRes.headers.get("content-type"),
        bytes: buf.byteLength,
        duration_ms: Date.now() - getStart,
        firstBytesHex: Buffer.from(buf.slice(0, 16)).toString("hex"),
      };
    }
  } catch (err) {
    stages.get = { error: err instanceof Error ? err.message : String(err) };
  }

  // 3. Roda transcribeAudioFromUrl (helper)
  try {
    const transStart = Date.now();
    const result = await transcribeAudioFromUrl(audioUrl, mimeType);
    if (result) {
      stages.transcribe = {
        ok: true,
        text: result.text.slice(0, 1000),
        text_length: result.text.length,
        audio_seconds: result.audio_seconds,
        duration_ms: result.duration_ms,
        wall_ms: Date.now() - transStart,
        model: result.model,
      };
    } else {
      stages.transcribe = {
        ok: false,
        result: "null",
        wall_ms: Date.now() - transStart,
        note: "helper retornou null",
      };
    }
  } catch (err) {
    stages.transcribe = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
    };
  }

  // 4. Whisper RAW — chama OpenAI direto pra ver response completo
  try {
    const rawStart = Date.now();
    const getRes2 = await fetch(audioUrl, { signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await getRes2.arrayBuffer());
    const { default: OpenAI } = await import("openai");
    const { toFile } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = await toFile(buf, "audio.ogg", { type: mimeType || "audio/ogg" });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "pt",
      response_format: "verbose_json",
    });
    stages.whisper_raw = {
      ok: true,
      duration_ms: Date.now() - rawStart,
      text: typeof transcription === "object" && "text" in transcription
        ? String((transcription as { text?: unknown }).text || "").slice(0, 1000)
        : null,
      duration_audio: typeof transcription === "object" && "duration" in transcription
        ? (transcription as { duration?: unknown }).duration
        : null,
      raw_response_keys: Object.keys(transcription as object),
      raw_response: JSON.stringify(transcription).slice(0, 2000),
    };
  } catch (err) {
    stages.whisper_raw = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 1200) : undefined,
    };
  }

  return NextResponse.json({ ok: true, stages });
}
