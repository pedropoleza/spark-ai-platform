/**
 * Helpers dos controles do agente injetados na UI do GHL (GU-1, Pedro 2026-06-04).
 * Compartilhado entre /api/agents/contact-status, /contact-pause, /message-feedback.
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GHLClient } from "@/lib/ghl/client";
import { classifyLastOutbound, extractAiSentTexts } from "@/lib/queue/human-takeover";
import { checkContactMatchesTargeting } from "@/lib/queue/targeting";
import type { TargetingRule } from "@/types/agent";

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

export type DrivingReason =
  | "active"
  | "paused_manual"
  | "human_handling"
  | "not_targeted"
  | "max_messages"
  | "paused_auto";

export interface DrivingState {
  driving: boolean; // true = IA conduz a conversa (pill LIGADO)
  reason: DrivingReason;
}

function classifyPauseReason(reason: string | null): DrivingReason {
  const r = (reason || "").toLowerCase();
  if (r.startsWith("manual")) return "paused_manual";
  if (r.includes("human_message") || r.includes("auto_pause:human")) return "human_handling";
  if (r.includes("max_messages")) return "max_messages";
  return "paused_auto";
}

/**
 * Estado REAL de "quem dirige a conversa" (GU-6, Pedro 2026-06-04).
 * OFF se: ai_paused_at (manual/auto), OU humano respondeu por ÚLTIMO (anti-eco
 * live, mais recente que ai_resumed_at), OU targeting exclui o contato.
 * ON caso contrário. Fail-open: erro no GHL não trava o pill.
 */
export async function computeContactDrivingState(args: {
  supabase: SupabaseClient;
  ghlClient: GHLClient;
  agentId: string;
  contactId: string;
  locationId: string;
  companyId: string;
}): Promise<DrivingState> {
  const { supabase, ghlClient, agentId, contactId, locationId, companyId } = args;

  // 1. Pausa (manual ou auto) — fonte da verdade persistida.
  const { data: cs } = await supabase
    .from("conversation_state")
    .select("ai_paused_at, ai_paused_reason, ai_resumed_at, conversation_id")
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .maybeSingle();
  const convState = cs as
    | { ai_paused_at: string | null; ai_paused_reason: string | null; ai_resumed_at: string | null; conversation_id: string | null }
    | null;
  if (convState?.ai_paused_at) {
    return { driving: false, reason: classifyPauseReason(convState.ai_paused_reason) };
  }

  // 2. Config (auto_pause + targeting).
  const { data: cfg } = await supabase
    .from("agent_configs")
    .select("auto_pause_on_human_message, targeting_rules")
    .eq("agent_id", agentId)
    .maybeSingle();
  const autoPause = (cfg as { auto_pause_on_human_message?: boolean } | null)?.auto_pause_on_human_message === true;
  const targetingRules = (cfg as { targeting_rules?: TargetingRule[] } | null)?.targeting_rules ?? null;

  // 3. Humano assumiu? (última outbound do GHL não é da IA, mais recente que o
  //    "ligar manual"). Só quando a conta quer auto-pause-on-human. Fail-open.
  if (autoPause) {
    try {
      const human = await lastOutboundIsHuman({
        supabase,
        ghlClient,
        contactId,
        locationId,
        conversationId: convState?.conversation_id || null,
      });
      if (human?.isHuman) {
        const resumedAt = convState?.ai_resumed_at ? new Date(convState.ai_resumed_at).getTime() : 0;
        const outboundAt = human.at ? new Date(human.at).getTime() : 0;
        if (!resumedAt || outboundAt > resumedAt) {
          return { driving: false, reason: "human_handling" };
        }
      }
    } catch {
      /* fail-open */
    }
  }

  // 4. Targeting exclui? (checkContactMatchesTargeting é fail-open por dentro)
  if (targetingRules && targetingRules.length > 0) {
    const match = await checkContactMatchesTargeting(contactId, targetingRules, companyId, locationId);
    if (!match.ok) return { driving: false, reason: "not_targeted" };
  }

  return { driving: true, reason: "active" };
}

/**
 * Última msg OUTBOUND do GHL é de humano (não da IA)? + quando.
 * Delega pra `classifyLastOutbound` (mesma ladder F52 do runtime que pausa a IA),
 * pra o pill concluir EXATAMENTE o que o queue-processor concluiria — sem cópia
 * divergente. Busca `userId`/`source` do outbound (não só body/direction/data):
 * são discriminadores da ladder (welcome/campanha do GHL e envio manual de user
 * só são distinguíveis com eles). Anti-eco/mídia já vêm dentro da função.
 */
async function lastOutboundIsHuman(args: {
  supabase: SupabaseClient;
  ghlClient: GHLClient;
  contactId: string;
  locationId: string;
  conversationId: string | null;
}): Promise<{ isHuman: boolean; at: string | null } | null> {
  const { supabase, ghlClient, contactId, locationId } = args;
  let convId = args.conversationId;
  if (!convId) {
    const search = await ghlClient
      .get<{ conversations?: Array<{ id: string }> }>("/conversations/search", { locationId, contactId })
      .catch(() => null);
    convId = search?.conversations?.[0]?.id || null;
  }
  if (!convId) return null;
  const resp = await ghlClient
    .get<{ messages?: { messages?: Array<{ direction: string; body?: string; dateAdded: string; userId?: string; source?: string }> } }>(
      `/conversations/${convId}/messages`,
      { locationId },
    )
    .catch(() => null);
  const msgs = resp?.messages?.messages || [];
  const lastOutbound = [...msgs]
    .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime())
    .reverse()
    .find((m) => m.direction === "outbound");
  if (!lastOutbound) return null;
  // Anti-eco precisa dos textos que a IA enviou — busca SEMPRE (mesmo sem body,
  // mídia/áudio), igual ao runtime: a ladder decide via aiTexts, não o !body cru.
  const { data: aiSends } = await supabase
    .from("execution_log")
    .select("action_payload")
    .eq("location_id", locationId)
    .eq("contact_id", contactId)
    .eq("action_type", "send_message")
    .eq("success", true)
    .order("created_at", { ascending: false })
    .limit(30);
  const { isHuman } = classifyLastOutbound({
    lastOutbound,
    aiTexts: extractAiSentTexts(aiSends || []),
  });
  return { isHuman, at: lastOutbound.dateAdded };
}
