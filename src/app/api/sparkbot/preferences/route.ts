/**
 * Preferências per-rep do SparkBot — editáveis no painel web (Pedro 2026-06-09).
 *
 * Surface na UI das configs que o bot define sozinho via conversa:
 *   - verbosity (tamanho das respostas) → set_verbosity_preference
 *   - timezone (fuso)                   → confirm_rep_timezone
 *   - daily_briefing_enabled (resumo)   → set_daily_briefing
 *
 * O calendário/duração padrão fica no endpoint dedicado /scheduling-prefs
 * (lista calendários do Spark Leads). Aqui só o que NÃO depende de GHL, pra
 * salvar rápido e sem acoplar.
 *
 * GET  → pref atual do rep.
 * POST → salva o que vier (campos ausentes não mexem). Merge manual em
 *        profile.preferences pra NÃO clobberar scheduling/tone/aliases.
 *
 * Auth: Bearer JWT do /check-admin (per-rep). Mesma persistência das tools.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { findRepById, updateRepById } from "@/lib/repositories/rep-identities.repo";

export const maxDuration = 20;

const VERBOSITY_VALUES = ["brief", "normal", "detailed"] as const;

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

/** Valida timezone IANA via Intl (throw = inválido). Sem libs externas. */
function isValidIana(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const json = responder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const rep = await findRepById(tok.rep_id);
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  const prefs = (rep.profile?.preferences || {}) as Record<string, unknown>;
  const verbosity =
    typeof prefs.verbosity === "string" && (VERBOSITY_VALUES as readonly string[]).includes(prefs.verbosity)
      ? prefs.verbosity
      : "normal";
  // daily_briefing_enabled: default ON pra rep novo (espelha set_daily_briefing).
  const briefing = (rep as { daily_briefing_enabled?: boolean }).daily_briefing_enabled;

  return json({
    ok: true,
    verbosity,
    timezone: rep.timezone || null,
    daily_briefing_enabled: briefing !== false,
  });
}

export async function POST(request: NextRequest) {
  const json = responder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const rep = await findRepById(tok.rep_id);
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  // ---- valida cada campo (ausente = não mexe) ----
  let verbosity: string | undefined;
  if (typeof body.verbosity === "string") {
    if (!(VERBOSITY_VALUES as readonly string[]).includes(body.verbosity)) {
      return json({ ok: false, reason: "verbosity_invalid" }, { status: 400 });
    }
    verbosity = body.verbosity;
  }

  let timezone: string | undefined;
  if (typeof body.timezone === "string" && body.timezone.trim()) {
    const tz = body.timezone.trim();
    if (!isValidIana(tz)) {
      return json({ ok: false, reason: "timezone_invalid" }, { status: 400 });
    }
    timezone = tz;
  }

  const briefing =
    typeof body.daily_briefing_enabled === "boolean" ? body.daily_briefing_enabled : undefined;

  if (verbosity === undefined && timezone === undefined && briefing === undefined) {
    return json({ ok: false, reason: "nothing_to_save" }, { status: 400 });
  }

  // ---- monta o update (merge manual pra não clobberar outras prefs) ----
  const currentProfile = (rep.profile || {}) as Record<string, unknown>;
  const currentPrefs = (currentProfile.preferences || {}) as Record<string, unknown>;
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (verbosity !== undefined) {
    update.profile = {
      ...currentProfile,
      preferences: { ...currentPrefs, verbosity },
    };
  }
  if (timezone !== undefined) {
    update.timezone = timezone;
    update.timezone_confirmed_at = new Date().toISOString();
  }
  if (briefing !== undefined) {
    update.daily_briefing_enabled = briefing;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateRepById(tok.rep_id, update as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, reason: msg }, { status: 500 });
  }

  return json({
    ok: true,
    verbosity: verbosity ?? (currentPrefs.verbosity as string | undefined) ?? "normal",
    timezone: timezone ?? rep.timezone ?? null,
    daily_briefing_enabled:
      briefing ?? (rep as { daily_briefing_enabled?: boolean }).daily_briefing_enabled !== false,
  });
}
