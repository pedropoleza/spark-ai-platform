/**
 * POST /api/agents/contact-activate  { contactId, agentId?: string|null }
 *
 * GU-7 (Pedro 2026-06-04): seletor ÚNICO de agente por contato. Liga UM agente
 * lead-facing pra esse contato e PAUSA todos os outros (não pode ter 2 agentes
 * lidando com o mesmo contato). agentId null/"" = desliga todos (ninguém atende).
 *
 * Fonte da verdade = conversation_state. Pro escolhido: ai_paused_at=null +
 * ai_resumed_at=now (override "passa a bola pra IA", igual contact-pause ON).
 * Pros outros: ai_paused_at=now (só nos que JÁ têm linha — não cria linha vazia
 * pra agente que nunca engajou).
 *
 * Auth: Bearer JWT do /api/agents/ui-auth. location_id e ghl_user_id do token.
 *
 * 200: { ok:true, activeAgentId: string|null }
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-7).
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { LEAD_FACING_TYPES, agentBelongsToLocation } from "@/lib/agents/contact-controls";
import { reenqueueInboundsSincePause } from "@/lib/queue/resume-reenqueue";

export const maxDuration = 20;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request, "POST, OPTIONS") });
}

export async function POST(request: NextRequest) {
  const cors = corsHeadersFor(request, "POST, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...cors, ...(init.headers || {}) } });

  const token = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!token) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const contactId = String(body.contactId || "").trim();
    const agentId = body.agentId ? String(body.agentId).trim() : null;
    if (!contactId) return json({ ok: false, reason: "missing_contactId" }, { status: 400 });

    const supabase = createAdminClient();
    const locationId = token.location_id;
    const userId = token.ghl_user_id;

    // Valida o agente escolhido (se houver): tem que ser da location.
    if (agentId) {
      const ok = await agentBelongsToLocation(supabase, agentId, locationId);
      if (!ok) return json({ ok: false, reason: "agent_not_in_location" }, { status: 403 });
    }

    // Todos os agentes lead-facing ativos da location (universo do seletor único).
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id")
      .eq("location_id", locationId)
      .eq("status", "active")
      .in("type", LEAD_FACING_TYPES as unknown as string[]);
    const agentIds = (agentRows || []).map((a) => (a as { id: string }).id);
    if (agentId && !agentIds.includes(agentId)) {
      return json({ ok: false, reason: "agent_not_lead_facing" }, { status: 403 });
    }

    const nowIso = new Date().toISOString();

    // Liga o escolhido (UPDATE-then-INSERT: precisa existir pra dirigir).
    if (agentId) {
      await setActive(supabase, { agentId, contactId, locationId, nowIso });
    }

    // Pausa todos os OUTROS que já têm linha (não cria linha vazia).
    const toPause = agentIds.filter((id) => id !== agentId);
    if (toPause.length > 0) {
      await supabase
        .from("conversation_state")
        .update({
          status: "handed_off",
          ai_paused_at: nowIso,
          ai_paused_reason: `manual_ui:switch:user_${userId}`,
          ai_resumed_at: null,
          updated_at: nowIso,
        })
        .eq("contact_id", contactId)
        .in("agent_id", toPause)
        .is("ai_paused_at", null); // só os que estavam ligados (evita writes à toa)
    }

    return json({ ok: true, activeAgentId: agentId });
  } catch (err) {
    console.error("[contact-activate] erro:", err instanceof Error ? err.message : err);
    // Sweep F49 2026-06-05: seleção de qual agente atende o contato falhou →
    // pode ficar sem agente OU com agente errado dirigindo.
    reportError({ title: "Contact activate: ativação de agente falhou", feature: "agents-contact-controls", severity: "medium", error: err });
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}

/** Liga UM agente pro contato (UPDATE-then-INSERT preserva conversation_id). */
async function setActive(
  supabase: ReturnType<typeof createAdminClient>,
  args: { agentId: string; contactId: string; locationId: string; nowIso: string },
) {
  const { agentId, contactId, locationId, nowIso } = args;
  // Captura a janela de pausa ANTES de limpar — pra recuperar inbounds engolidos
  // durante a pausa (Fix prod 2026-06-18, caso Marina).
  const { data: prev } = await supabase
    .from("conversation_state")
    .select("ai_paused_at, ai_paused_reason")
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .maybeSingle();

  const patch = {
    status: "active",
    ai_paused_at: null,
    ai_paused_reason: null,
    ai_resumed_at: nowIso, // override "passa a bola pra IA" (F52 não re-pausa sem humano depois)
    updated_at: nowIso,
  };
  const { data: updated } = await supabase
    .from("conversation_state")
    .update(patch)
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .select("agent_id");
  if (!updated || updated.length === 0) {
    await supabase.from("conversation_state").insert({
      agent_id: agentId,
      location_id: locationId,
      contact_id: contactId,
      conversation_id: "",
      ...patch,
    });
  }

  // Recupera inbounds engolidos durante a pausa (fail-soft).
  await reenqueueInboundsSincePause(supabase, {
    agentId,
    contactId,
    pausedSince: (prev as { ai_paused_at: string | null } | null)?.ai_paused_at,
    pausedReason: (prev as { ai_paused_reason: string | null } | null)?.ai_paused_reason,
  });
}
