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
  // Auth
  const expectedKey = process.env.DEBUG_REPLAY_KEY;
  if (!expectedKey || req.headers.get("x-debug-key") !== expectedKey) {
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

  // 3. Roda transcribeAudioFromUrl propriamente
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
        note: "transcribeAudioFromUrl retornou null — ver logs Vercel pra detalhe (response.ok=false, file too small/large, ou Whisper retornou empty)",
      };
    }
  } catch (err) {
    stages.transcribe = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
    };
  }

  return NextResponse.json({ ok: true, stages });
}
