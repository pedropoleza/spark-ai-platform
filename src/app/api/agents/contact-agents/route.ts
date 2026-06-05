/**
 * GET /api/agents/contact-agents?contactId=...
 *
 * GU-7 (Pedro 2026-06-04): lista TODOS os agentes lead-facing da location +
 * o estado de cada um PRA ESTE CONTATO, pro seletor único do robozinho na UI
 * do Spark Leads. O loader usa isso pra (a) colorir o ícone (verde=on / vermelho=off
 * / cinza=sem agente) e (b) preencher o popup de seleção.
 *
 * Estado por agente:
 *   - "driving": é quem conduz a conversa AGORA (computeContactDrivingState live).
 *   - "paused":  tem conversation_state com ai_paused_at (desligado/handoff).
 *   - "idle":    nunca engajou esse contato (sem conversation_state).
 *
 * Auth: Bearer JWT do /api/agents/ui-auth (location_id + company_id do token =
 * fronteira de segurança). contactId vem do query.
 *
 * 200: { ok:true, hasAnyAgent:bool, activeAgentId:string|null,
 *        agents: [{ id, name, type, state }] }
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-7).
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { LEAD_FACING_TYPES, computeContactDrivingState } from "@/lib/agents/contact-controls";
import { GHLClient } from "@/lib/ghl/client";

export const maxDuration = 25;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request, "GET, OPTIONS") });
}

export async function GET(request: NextRequest) {
  const cors = corsHeadersFor(request, "GET, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...cors, ...(init.headers || {}) } });

  const token = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!token) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const contactId = new URL(request.url).searchParams.get("contactId")?.trim();
  if (!contactId) return json({ ok: false, reason: "missing_contactId" }, { status: 400 });

  try {
    const supabase = createAdminClient();
    const locationId = token.location_id;

    // 1. Todos os agentes lead-facing ativos da location.
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id, name, type")
      .eq("location_id", locationId)
      .eq("status", "active")
      .in("type", LEAD_FACING_TYPES as unknown as string[])
      .order("created_at");

    const agents = (agentRows || []) as { id: string; name: string | null; type: string }[];
    if (agents.length === 0) {
      return json({ ok: true, hasAnyAgent: false, activeAgentId: null, agents: [] });
    }

    // 2. conversation_state desses agentes pra esse contato (1 query).
    const ids = agents.map((a) => a.id);
    const { data: stateRows } = await supabase
      .from("conversation_state")
      .select("agent_id, ai_paused_at")
      .eq("contact_id", contactId)
      .in("agent_id", ids);
    const stateByAgent = new Map<string, { ai_paused_at: string | null }>();
    for (const s of (stateRows || []) as { agent_id: string; ai_paused_at: string | null }[]) {
      stateByAgent.set(s.agent_id, { ai_paused_at: s.ai_paused_at });
    }

    // 3. Estado por agente. Só roda o check live (computeContactDrivingState, que
    //    faz 1 fetch no Spark Leads) pros agentes com conversa ATIVA (não pausada) —
    //    no modelo seletor-único é ≤1, então no máximo 1 call.
    const ghlClient = new GHLClient(token.company_id, locationId);
    let activeAgentId: string | null = null;
    const out: { id: string; name: string; type: string; state: "driving" | "paused" | "idle" }[] = [];

    for (const a of agents) {
      const st = stateByAgent.get(a.id);
      let state: "driving" | "paused" | "idle";
      if (!st) {
        state = "idle";
      } else if (st.ai_paused_at) {
        state = "paused";
      } else {
        // Conversa ativa: confirma "quem dirige" ao vivo (humano pode ter assumido).
        const driving = await computeContactDrivingState({
          supabase,
          ghlClient,
          agentId: a.id,
          contactId,
          locationId,
          companyId: token.company_id,
        });
        if (driving.driving) {
          state = "driving";
          if (!activeAgentId) activeAgentId = a.id;
        } else {
          state = "paused";
        }
      }
      out.push({ id: a.id, name: a.name || "", type: a.type, state });
    }

    return json({ ok: true, hasAnyAgent: true, activeAgentId, agents: out });
  } catch (err) {
    console.error("[contact-agents] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
