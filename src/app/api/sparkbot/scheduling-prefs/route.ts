/**
 * Preferência de agendamento do rep — endpoint do painel web (Agendamento V2, E4).
 *
 * GET  /api/sparkbot/scheduling-prefs → lista calendários da location + pref atual
 * POST /api/sparkbot/scheduling-prefs → salva { default_calendar_id, default_duration_min? }
 *
 * Auth: Bearer JWT do /check-admin (per-rep). Espelha a mesma persistência da
 * tool `set_scheduling_pref` (merge manual em profile.preferences.scheduling
 * pra não clobberar verbosity/tone/aliases). É o caminho "Setting na UI" da D2;
 * o "aprende no 1º uso" (bot pergunta no chat) é o caminho complementar.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { findRepById, updateRepById } from "@/lib/repositories/rep-identities.repo";
import { GHLClient } from "@/lib/ghl/client";
import { listCalendars as ghlListCalendars } from "@/lib/ghl/operations";
import type { RepProfile } from "@/types/account-assistant";

export const maxDuration = 30;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeadersFor(request, "GET, POST, OPTIONS"),
  });
}

function responder(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request, "GET, POST, OPTIONS");
  return (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...corsHeaders, ...(init.headers || {}) } });
}

/** Extrai a pref de agendamento salva do rep (pode estar vazia). */
function readSchedulingPref(profile: RepProfile | null | undefined) {
  return profile?.preferences?.scheduling || {};
}

/**
 * GET — calendários da location (pro dropdown) + pref atual do rep.
 */
export async function GET(request: NextRequest) {
  const json = responder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const rep = await findRepById(tok.rep_id);
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  const current = readSchedulingPref(rep.profile);

  // Lista calendários da location em que o painel foi aberto (tok.location_id).
  let calendars: Array<{ id: string; name: string }> = [];
  try {
    const client = new GHLClient(tok.company_id, tok.location_id);
    const res = await ghlListCalendars(client, tok.location_id);
    calendars = (res.calendars || [])
      .filter((c): c is typeof c & { id: string } => !!c.id)
      .map((c) => ({ id: c.id, name: c.name || "(sem nome)" }));
  } catch (err) {
    // Não derruba a tela de settings — devolve a pref atual e calendários vazios.
    console.warn(
      "[scheduling-prefs] falha ao listar calendários:",
      err instanceof Error ? err.message.slice(0, 160) : err,
    );
    return json({
      ok: true,
      calendars: [],
      current,
      calendars_error: "Não consegui carregar os calendários agora. Tente de novo em instantes.",
    });
  }

  return json({ ok: true, calendars, current });
}

/**
 * POST — salva o calendário/duração padrão. Body:
 *   { default_calendar_id: string, default_duration_min?: number }
 * Passar default_calendar_id="" (vazio) LIMPA a preferência (volta a perguntar).
 */
export async function POST(request: NextRequest) {
  const json = responder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const rawCalendarId = typeof body.default_calendar_id === "string" ? body.default_calendar_id.trim() : "";

  const rep = await findRepById(tok.rep_id);
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  // Lista calendários pra (a) validar o id escolhido e (b) pegar o nome.
  let calendars: Array<{ id: string; name: string }> = [];
  try {
    const client = new GHLClient(tok.company_id, tok.location_id);
    const res = await ghlListCalendars(client, tok.location_id);
    calendars = (res.calendars || [])
      .filter((c): c is typeof c & { id: string } => !!c.id)
      .map((c) => ({ id: c.id, name: c.name || "(sem nome)" }));
  } catch {
    return json({ ok: false, reason: "calendars_unavailable" }, { status: 502 });
  }

  // Duração: aceita só valores sãos (5min–8h). Fora disso, ignora.
  let durationMin: number | undefined;
  if (typeof body.default_duration_min === "number" && isFinite(body.default_duration_min)) {
    const d = Math.round(body.default_duration_min);
    if (d >= 5 && d <= 480) durationMin = d;
  }

  // Merge manual das preferences pra NÃO clobberar verbosity/tone/aliases.
  const currentProfile = (rep.profile || {}) as Record<string, unknown>;
  const currentPrefs = (currentProfile.preferences || {}) as Record<string, unknown>;
  const currentScheduling = (currentPrefs.scheduling || {}) as Record<string, unknown>;

  let newScheduling: Record<string, unknown>;
  if (rawCalendarId === "") {
    // Limpa o calendário padrão (mantém duração se ainda fizer sentido — mas
    // sem calendário a duração órfã não ajuda; limpa as duas pra ficar claro).
    newScheduling = {};
  } else {
    const match = calendars.find((c) => c.id === rawCalendarId);
    if (!match) {
      return json({ ok: false, reason: "calendar_not_found" }, { status: 400 });
    }
    newScheduling = {
      ...currentScheduling,
      default_calendar_id: rawCalendarId,
      default_calendar_name: match.name,
    };
    if (durationMin !== undefined) newScheduling.default_duration_min = durationMin;
  }

  const newProfile = {
    ...currentProfile,
    preferences: { ...currentPrefs, scheduling: newScheduling },
  };

  try {
    await updateRepById(tok.rep_id, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      profile: newProfile as any,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, reason: msg }, { status: 500 });
  }

  return json({ ok: true, current: newScheduling });
}
