/**
 * Helpers dos controles do agente injetados na UI do GHL (GU-1, Pedro 2026-06-04).
 * Compartilhado entre /api/agents/contact-status, /contact-pause, /message-feedback.
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const LEAD_FACING_TYPES = ["sales_agent", "recruitment_agent", "custom_agent"] as const;

export interface ResolvedAgent {
  id: string;
  name: string;
  type: string;
}

/**
 * Resolve o agente lead-facing relevante pro contato:
 *   1. O que JÁ engaja o contato (tem conversation_state) — é quem responde.
 *   2. Senão, o único agente lead-facing ativo da location.
 *   3. Se há vários e nenhum engajou ainda, pega o primeiro (MVP).
 * Retorna null se a location não tem agente lead-facing ativo (→ não mostra controles).
 */
export async function resolveAgentForContact(
  supabase: SupabaseClient,
  locationId: string,
  contactId: string,
): Promise<ResolvedAgent | null> {
  // 1. Agente que já tem conversa com esse contato
  const { data: states } = await supabase
    .from("conversation_state")
    .select("agent_id")
    .eq("location_id", locationId)
    .eq("contact_id", contactId)
    .limit(1);
  const engagingAgentId = states?.[0]?.agent_id as string | undefined;
  if (engagingAgentId) {
    const { data: a } = await supabase
      .from("agents")
      .select("id, name, type, status")
      .eq("id", engagingAgentId)
      .maybeSingle();
    if (a && a.status === "active" && (LEAD_FACING_TYPES as readonly string[]).includes(a.type)) {
      return { id: a.id, name: a.name || "", type: a.type };
    }
  }

  // 2/3. Agentes lead-facing ativos da location
  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, type")
    .eq("location_id", locationId)
    .eq("status", "active")
    .in("type", LEAD_FACING_TYPES as unknown as string[]);

  if (agents && agents.length > 0) {
    const a = agents[0];
    return { id: a.id, name: a.name || "", type: a.type };
  }
  return null;
}

/** Confere se um agentId pertence à location (defesa: não confiar no client). */
export async function agentBelongsToLocation(
  supabase: SupabaseClient,
  agentId: string,
  locationId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("location_id", locationId)
    .maybeSingle();
  return !!data;
}

/** Estado de pausa do agente pro contato (lê conversation_state.ai_paused_at). */
export async function getContactPauseState(
  supabase: SupabaseClient,
  agentId: string,
  contactId: string,
): Promise<{ paused: boolean; reason: string | null }> {
  const { data } = await supabase
    .from("conversation_state")
    .select("ai_paused_at, ai_paused_reason")
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .maybeSingle();
  return { paused: !!data?.ai_paused_at, reason: (data?.ai_paused_reason as string | null) ?? null };
}
