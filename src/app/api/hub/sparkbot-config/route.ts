/**
 * Config do SparkBot pela tela dedicada do /hub (Pedro 2026-06-09).
 *
 * Diferente dos endpoints /api/sparkbot/* (que usam o JWT do painel embed),
 * este usa a SESSÃO do /hub (getSession). Junta num lugar só:
 *   - Per-rep (do admin logado): verbosity, timezone, daily_briefing
 *     → rep_identities (mesmos campos das tools set_verbosity_preference /
 *       confirm_rep_timezone / set_daily_briefing → SINCRONIZADO com o bot).
 *   - Agência (admin-only): tone_* + custom_instructions do agente
 *     account_assistant (afeta todos os reps).
 *
 * GET  → { is_admin, prefs{verbosity,timezone,daily_briefing_enabled}, agency? }
 * POST → salva o que vier. Agência só se is_admin.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { identifyRepByGhlUser } from "@/lib/account-assistant/identity";
import { updateRepById } from "@/lib/repositories/rep-identities.repo";
import { resolvePrimaryHub } from "@/lib/account-assistant/hub-resolver";
import { findAgentConfig } from "@/lib/repositories/agents.repo";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 20;

const VERBOSITY = ["brief", "normal", "detailed"] as const;

function isValidIana(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
function clampTone(v: unknown): number | null {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const rep = await identifyRepByGhlUser({
    ghlUserId: session.userId,
    locationId: session.locationId,
    companyId: session.companyId,
  });

  const prefs = (rep?.profile?.preferences || {}) as Record<string, unknown>;
  const verbosity =
    typeof prefs.verbosity === "string" && (VERBOSITY as readonly string[]).includes(prefs.verbosity)
      ? prefs.verbosity
      : "normal";
  const out: Record<string, unknown> = {
    ok: true,
    is_admin: !!session.isAdmin,
    prefs: {
      verbosity,
      timezone: rep?.timezone || null,
      daily_briefing_enabled:
        (rep as { daily_briefing_enabled?: boolean } | null)?.daily_briefing_enabled !== false,
    },
  };

  // Config de agência só pra admin.
  if (session.isAdmin) {
    const hub = await resolvePrimaryHub();
    if (hub?.agentId) {
      const cfg = await findAgentConfig(hub.agentId);
      out.agency = {
        agent_found: true,
        tone: {
          creativity: cfg?.tone_creativity ?? 50,
          formality: cfg?.tone_formality ?? 50,
          naturalness: cfg?.tone_naturalness ?? 50,
          aggressiveness: cfg?.tone_aggressiveness ?? 50,
        },
        custom_instructions: cfg?.custom_instructions ?? "",
      };
    } else {
      out.agency = { agent_found: false };
    }
  }

  return NextResponse.json(out);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));

  // ---- per-rep (do admin logado) ----
  const rep = await identifyRepByGhlUser({
    ghlUserId: session.userId,
    locationId: session.locationId,
    companyId: session.companyId,
  });
  if (rep) {
    const update: Record<string, unknown> = {};
    if (body.prefs && typeof body.prefs === "object") {
      const p = body.prefs as Record<string, unknown>;
      if (typeof p.verbosity === "string" && (VERBOSITY as readonly string[]).includes(p.verbosity)) {
        const cur = (rep.profile || {}) as Record<string, unknown>;
        const curPrefs = (cur.preferences || {}) as Record<string, unknown>;
        update.profile = { ...cur, preferences: { ...curPrefs, verbosity: p.verbosity } };
      }
      if (typeof p.timezone === "string" && p.timezone.trim()) {
        const tz = p.timezone.trim();
        if (isValidIana(tz)) {
          update.timezone = tz;
          update.timezone_confirmed_at = new Date().toISOString();
        }
      }
      if (typeof p.daily_briefing_enabled === "boolean") {
        update.daily_briefing_enabled = p.daily_briefing_enabled;
      }
    }
    if (Object.keys(update).length > 0) {
      update.updated_at = new Date().toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { await updateRepById(rep.id, update as any); } catch { /* não-bloqueante */ }
    }
  }

  // ---- agência (admin-only) ----
  if (session.isAdmin && body.agency && typeof body.agency === "object") {
    const hub = await resolvePrimaryHub();
    if (hub?.agentId) {
      const ag = body.agency as Record<string, unknown>;
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (ag.tone && typeof ag.tone === "object") {
        const t = ag.tone as Record<string, unknown>;
        const cre = clampTone(t.creativity);
        const form = clampTone(t.formality);
        const nat = clampTone(t.naturalness);
        const agg = clampTone(t.aggressiveness);
        if (cre !== null) update.tone_creativity = cre;
        if (form !== null) update.tone_formality = form;
        if (nat !== null) update.tone_naturalness = nat;
        if (agg !== null) update.tone_aggressiveness = agg;
      }
      if (typeof ag.custom_instructions === "string") {
        update.custom_instructions = ag.custom_instructions.slice(0, 8000);
      }
      if (Object.keys(update).length > 1) {
        const supabase = createAdminClient();
        const { error } = await supabase.from("agent_configs").update(update).eq("agent_id", hub.agentId);
        if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
