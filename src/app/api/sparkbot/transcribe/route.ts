/**
 * POST /api/sparkbot/transcribe
 *
 * Recebe um blob de áudio (multipart/form-data, field 'audio') gravado pelo
 * painel web e devolve a transcrição em texto. O painel usa o texto pra
 * popular a composer (rep pode editar antes de enviar).
 *
 * Auth: Bearer JWT do /check-admin.
 *
 * Body: multipart/form-data { audio: File (blob webm/ogg) }
 * Resposta: { ok: true, text: string, audio_seconds: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { trackAndCharge } from "@/lib/billing/charge";
import OpenAI, { toFile } from "openai";

export const maxDuration = 30;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
  NextResponse.json(data, { ...init, headers: { ...CORS_HEADERS, ...(init.headers || {}) } });

export async function POST(request: NextRequest) {
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const formData = await request.formData().catch(() => null);
  if (!formData) return json({ ok: false, reason: "invalid_form_data" }, { status: 400 });

  const audio = formData.get("audio") as File | null;
  if (!audio) return json({ ok: false, reason: "missing_audio" }, { status: 400 });

  // Limites defensivos: máx 25MB (limite do Whisper)
  if (audio.size > 25 * 1024 * 1024) {
    return json({ ok: false, reason: "audio_too_large" }, { status: 413 });
  }
  if (audio.size < 100) {
    return json({ ok: false, reason: "audio_too_small" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json({ ok: false, reason: "openai_not_configured" }, { status: 500 });

  try {
    const openai = new OpenAI({ apiKey, timeout: 60000, maxRetries: 1 });
    // O navegador grava em webm/opus por padrão; Whisper aceita.
    const ext = (audio.type.includes("webm") ? "webm"
              : audio.type.includes("ogg")  ? "ogg"
              : audio.type.includes("mp4")  ? "m4a"
              : "webm");
    const buffer = Buffer.from(await audio.arrayBuffer());
    const file = await toFile(buffer, `audio.${ext}`, { type: audio.type || `audio/${ext}` });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "pt",
      response_format: "verbose_json",
    }) as { text?: string; duration?: number };

    const text = (transcription.text || "").trim();
    const audioSeconds = typeof transcription.duration === "number" ? transcription.duration : 0;

    if (!text) {
      return json({ ok: false, reason: "empty_transcription" }, { status: 422 });
    }

    // Cobra Whisper. Defensivo — não bloqueia se billing falhar.
    // C4 fix: agent_id deve ser hubAgent.id (FK válida), não rep_id (UUID
    // de rep_identities, não de agents). Antes deste fix, INSERT de
    // usage_records falhava em FK violation silenciosamente → Whisper Web 100% free.
    try {
      const supabase = createAdminClient();
      const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
      let hubAgentId: string | null = null;
      if (hubLocationId) {
        const { data: hubAgent } = await supabase
          .from("agents")
          .select("id")
          .eq("location_id", hubLocationId)
          .eq("type", "account_assistant")
          .eq("status", "active")
          .maybeSingle();
        hubAgentId = hubAgent?.id || null;
      }

      const { data: ls } = await supabase
        .from("location_settings")
        .select("openai_api_key")
        .eq("location_id", tok.location_id)
        .maybeSingle();
      const usesCustomKey = !!ls?.openai_api_key;

      if (hubAgentId) {
        await trackAndCharge({
          locationId: tok.location_id,
          companyId: tok.company_id,
          agentId: hubAgentId, // FK válida vs agents(id)
          contactId: undefined,
          actionType: "audio_transcription",
          model: "whisper-1",
          audioSeconds,
          audioModel: "whisper-1",
          usesCustomKey,
        });
      } else {
        console.warn(
          "[transcribe] ASSISTANT_HUB_LOCATION_ID não setada ou hub agent inativo — " +
          "Whisper rodando sem billing. Setar env var no Vercel.",
        );
      }
    } catch (e) {
      console.warn("[transcribe] billing falhou (não-bloqueante):", e instanceof Error ? e.message : e);
    }

    return json({ ok: true, text, audio_seconds: audioSeconds });
  } catch (err) {
    console.error("[transcribe] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "transcription_failed" }, { status: 500 });
  }
}
