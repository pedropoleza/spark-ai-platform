/**
 * Config de AGÊNCIA do SparkBot — personalidade + instruções (Pedro 2026-06-09).
 *
 * Diferente de /preferences (per-rep): isto é a config do agente account_assistant
 * (agent_configs), que afeta o SparkBot de TODOS os reps. Por isso é ADMIN-ONLY
 * (detectIsInternal: agency owner/admin). O painel do rep só mostra esta seção
 * se is_admin=true.
 *
 * GET  → { is_admin, (se admin) tone{4}, custom_instructions }
 * POST → salva tone_* + custom_instructions no agente do hub. 403 se não-admin.
 *
 * Escopo: o hub primário (resolvePrimaryHub) — setup de hub único. Multi-hub
 * por-rep fica pra depois.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { findRepById } from "@/lib/repositories/rep-identities.repo";
import { detectIsInternal } from "@/lib/account-assistant/identity";
import { resolvePrimaryHub } from "@/lib/account-assistant/hub-resolver";
import { findAgentConfig } from "@/lib/repositories/agents.repo";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 20;

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

/** Clampa um slider de tom (0–100). null = valor inválido (não mexe). */
function clampTone(v: unknown): number | null {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export async function GET(request: NextRequest) {
  const json = responder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const rep = await findRepById(tok.rep_id);
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  if (!detectIsInternal(rep)) {
    // Rep comum: não expõe nada da config de agência.
    return json({ ok: true, is_admin: false });
  }

  const hub = await resolvePrimaryHub();
  if (!hub?.agentId) {
    return json({ ok: true, is_admin: true, agent_found: false });
  }
  const cfg = await findAgentConfig(hub.agentId);

  return json({
    ok: true,
    is_admin: true,
    agent_found: true,
    tone: {
      creativity: cfg?.tone_creativity ?? 50,
      formality: cfg?.tone_formality ?? 50,
      naturalness: cfg?.tone_naturalness ?? 50,
      aggressiveness: cfg?.tone_aggressiveness ?? 50,
    },
    custom_instructions: cfg?.custom_instructions ?? "",
  });
}

export async function POST(request: NextRequest) {
  const json = responder(request);
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const rep = await findRepById(tok.rep_id);
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  // Gate de admin: só agency owner/admin edita a config que afeta todos.
  if (!detectIsInternal(rep)) {
    return json({ ok: false, reason: "not_admin" }, { status: 403 });
  }

  const hub = await resolvePrimaryHub();
  if (!hub?.agentId) {
    return json({ ok: false, reason: "agent_not_found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.tone && typeof body.tone === "object") {
    const t = body.tone as Record<string, unknown>;
    const cre = clampTone(t.creativity);
    const form = clampTone(t.formality);
    const nat = clampTone(t.naturalness);
    const agg = clampTone(t.aggressiveness);
    if (cre !== null) update.tone_creativity = cre;
    if (form !== null) update.tone_formality = form;
    if (nat !== null) update.tone_naturalness = nat;
    if (agg !== null) update.tone_aggressiveness = agg;
  }
  if (typeof body.custom_instructions === "string") {
    update.custom_instructions = body.custom_instructions.slice(0, 8000);
  }

  if (Object.keys(update).length <= 1) {
    return json({ ok: false, reason: "nothing_to_save" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("agent_configs")
    .update(update)
    .eq("agent_id", hub.agentId);
  if (error) {
    return json({ ok: false, reason: error.message }, { status: 500 });
  }

  return json({ ok: true });
}
