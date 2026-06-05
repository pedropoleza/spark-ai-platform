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
import { reportError } from "@/lib/admin-signals/report-error";
import { corsHeadersFor } from "@/lib/utils/cors";
import { resolvePrimaryHub, getEnvHubLocationId } from "@/lib/account-assistant/hub-resolver";
import OpenAI, { toFile } from "openai";

export const maxDuration = 30;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeadersFor(request, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request, "POST, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...corsHeaders, ...(init.headers || {}) } });
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
      // H29 2026-05-20: hub via DB-first com fallback env
      const hubEntry = await resolvePrimaryHub();
      const hubLocationIdTx = hubEntry?.locationId ?? getEnvHubLocationId();
      const supabase = createAdminClient();
      let hubAgentId: string | null = hubEntry?.agentId || null;
      if (!hubAgentId && hubLocationIdTx) {
        const { data: hubAgentRow } = await supabase
          .from("agents")
          .select("id")
          .eq("location_id", hubLocationIdTx)
          .eq("type", "account_assistant")
          .eq("status", "active")
          .maybeSingle();
        hubAgentId = hubAgentRow?.id || null;
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
          "[transcribe] hub agent não encontrado (DB + env) — " +
          "Whisper rodando sem billing. Verificar agents account_assistant ativos.",
        );
      }
    } catch (e) {
      console.warn("[transcribe] billing falhou (não-bloqueante):", e instanceof Error ? e.message : e);
      // Sweep F49 2026-06-05: billing do Whisper crashou → usage_record pode
      // não ter sido inserido (sem retry pelo reaper). Receita perdida (pouca).
      reportError({ title: "SparkBot transcribe: billing falhou", feature: "sparkbot-transcribe", severity: "medium", error: e });
    }

    return json({ ok: true, text, audio_seconds: audioSeconds });
  } catch (err) {
    console.error("[transcribe] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "transcription_failed" }, { status: 500 });
  }
}
