/**
 * Reactive trigger — F27.D (Pedro 2026-05-29).
 *
 * Quando o GHL/Spark Leads notifica "tag adicionada" ou "lead entrou em
 * estágio", esse módulo:
 *  1. Lista agentes lead-facing ATIVOS da location.
 *  2. Filtra os que têm `targeting_rules` que bate com o evento.
 *  3. Pra cada match, enfileira UMA mensagem "trigger sintético" em
 *     `message_queue`. O queue-processor reconhece pelo prefix do body
 *     e gera 1ª mensagem proativa (sem esperar lead mandar nada).
 *
 * Idempotência: antes de disparar, consulta `execution_log` últimas 24h
 * com `action_type='reactive_trigger_fired'`. Se mesmo (agent, contact,
 * event_key) já fired = skip. Evita disparo em loop quando tag é
 * adicionada/removida várias vezes.
 *
 * Diferente do `reaction-engine.ts` (POST-LLM, reage a `on_data_field_set`),
 * esse é PRE-LLM: dispara o agente do zero quando webhook GHL chega.
 *
 * Gate: roda só quando `isProactiveEventsEnabled()` (env
 * `PROACTIVE_EVENTS_ENABLED`). Hoje OFF — só liga após smoke supervisionado.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { TargetingRule } from "@/types/agent";

const REACTIVE_TRIGGER_PREFIX = "__reactive_trigger__:";

export type ReactiveTriggerKind = "tag_added" | "tag_removed" | "stage_changed" | "contact_created";

export interface ReactiveTriggerContext {
  locationId: string;
  contactId: string;
  kind: ReactiveTriggerKind;
  /** Para tag_*: o nome da tag. Para stage_changed: o ID do estágio. */
  key: string;
  /** Para stage_changed: o pipeline ID (opcional). */
  pipelineId?: string;
}

interface AgentRow {
  id: string;
  type: string;
  audience: string | null;
  agent_configs:
    | {
        targeting_rules: TargetingRule[] | null;
        outreach_config: Record<string, unknown> | null;
      }
    | {
        targeting_rules: TargetingRule[] | null;
        outreach_config: Record<string, unknown> | null;
      }[]
    | null;
}

function extractConfig(agent: AgentRow) {
  const cfg = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;
  return {
    rules: (cfg?.targeting_rules || []) as TargetingRule[],
    outreachOn: !!(cfg?.outreach_config as { enabled?: boolean } | null)?.enabled,
  };
}

/**
 * Decide se o evento dispara o agente baseado nas targeting_rules.
 * AND lógico — todas regras precisam passar (mesma semântica do F27.A).
 *
 * Pra trigger reativo, o "match" significa: a regra inclui o evento.
 *  - tag_added "VIP": agente com rule {type:"tag", tag:"VIP"} → DISPARA
 *  - stage_changed "stageX": agente com rule {type:"pipeline_stage",
 *    pipeline_stage_id:"stageX"} → DISPARA
 *  - rules vazias → NÃO dispara (sem ativação reativa configurada)
 *
 * Custom_field ainda não tem trigger reativo aqui (precisa ContactUpdate
 * com diff de fields — fase 2).
 */
export function ruleMatchesTrigger(rules: TargetingRule[], ev: ReactiveTriggerContext): boolean {
  if (!rules || rules.length === 0) return false;
  // Pra trigger reativo, basta UMA regra bater o evento — não exige AND aqui,
  // pq se o rep marca {tag:"VIP", stage:"stageX"}, ambos eventos disparam.
  for (const rule of rules) {
    if (ev.kind === "tag_added" && rule.type === "tag" && rule.tag && ev.key === rule.tag) {
      return true;
    }
    if (
      ev.kind === "stage_changed" &&
      rule.type === "pipeline_stage" &&
      rule.pipeline_stage_id &&
      ev.key === rule.pipeline_stage_id &&
      (!rule.pipeline_id || !ev.pipelineId || rule.pipeline_id === ev.pipelineId)
    ) {
      return true;
    }
  }
  return false;
}

function eventKey(ev: ReactiveTriggerContext): string {
  return `${ev.kind}:${ev.key}${ev.pipelineId ? `:${ev.pipelineId}` : ""}`;
}

/**
 * Encode do trigger no body da queue. queue-processor detecta o prefix e
 * gera 1ª msg proativa (sem esperar lead mandar nada).
 */
export function encodeTriggerBody(ev: ReactiveTriggerContext): string {
  return `${REACTIVE_TRIGGER_PREFIX}${eventKey(ev)}`;
}

export function isReactiveTriggerBody(body: string | null | undefined): boolean {
  return !!body && body.startsWith(REACTIVE_TRIGGER_PREFIX);
}

export function parseTriggerBody(body: string): { kind: ReactiveTriggerKind; key: string; pipelineId?: string } | null {
  if (!isReactiveTriggerBody(body)) return null;
  const payload = body.slice(REACTIVE_TRIGGER_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length < 2) return null;
  const kind = parts[0] as ReactiveTriggerKind;
  const key = parts[1];
  const pipelineId = parts[2] || undefined;
  return { kind, key, pipelineId };
}

/**
 * Idempotência: checa se mesmo (agent, contact, eventKey) já foi disparado
 * nas últimas 24h. Usa execution_log como audit + cache.
 */
async function alreadyFired(
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string,
  contactId: string,
  ev: ReactiveTriggerContext,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("execution_log")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .eq("action_type", "reactive_trigger_fired")
    .gte("created_at", cutoff)
    .contains("action_payload", { event_key: eventKey(ev) });
  return (count ?? 0) > 0;
}

/**
 * Dispara o(s) agente(s) que devem reagir a esse evento.
 * Retorna count de triggers enfileirados.
 */
export async function triggerReactiveAgents(ev: ReactiveTriggerContext): Promise<{ fired: number; matched: number }> {
  if (!ev.contactId || !ev.locationId || !ev.key) return { fired: 0, matched: 0 };
  const supabase = createAdminClient();

  // Lista agentes lead-facing ATIVOS da location (rep-facing/SparkBot ignorado —
  // não tem targeting nem opera por evento de tag de lead).
  const { data: agents } = await supabase
    .from("agents")
    .select("id, type, audience, agent_configs(targeting_rules, outreach_config)")
    .eq("location_id", ev.locationId)
    .eq("status", "active")
    .in("type", ["sales_agent", "recruitment_agent", "custom_agent"]);

  if (!agents || agents.length === 0) return { fired: 0, matched: 0 };

  let matched = 0;
  let fired = 0;

  for (const a of agents as AgentRow[]) {
    if (a.audience && a.audience !== "lead") continue;
    const { rules, outreachOn } = extractConfig(a);
    // Outreach (bulk) tem seu próprio fluxo via bulk-runner — não dispara aqui.
    if (outreachOn) continue;
    if (!ruleMatchesTrigger(rules, ev)) continue;
    matched++;

    if (await alreadyFired(supabase, a.id, ev.contactId, ev)) continue;

    // Enfileira o trigger sintético. queue-processor detecta o prefix.
    const nowIso = new Date().toISOString();
    const { error: queueErr } = await supabase.from("message_queue").insert({
      agent_id: a.id,
      location_id: ev.locationId,
      contact_id: ev.contactId,
      // Sem conversation_id real — bot vai criar/buscar via GHL.
      conversation_id: "",
      message_body: encodeTriggerBody(ev),
      message_type: "REACTIVE_TRIGGER",
      message_direction: "system",
      ghl_message_id: null,
      received_at: nowIso,
      process_after: nowIso,
      status: "pending",
    });

    if (queueErr) {
      console.warn(`[reactive-trigger] enfileirar falhou agent=${a.id}: ${queueErr.message}`);
      continue;
    }

    // Audit + idempotência.
    await supabase.from("execution_log").insert({
      agent_id: a.id,
      location_id: ev.locationId,
      contact_id: ev.contactId,
      action_type: "reactive_trigger_fired",
      action_payload: { event_key: eventKey(ev), kind: ev.kind, key: ev.key, pipeline_id: ev.pipelineId || null },
      success: true,
    });

    fired++;
  }

  if (matched > 0) {
    console.log(`[reactive-trigger] ${ev.kind}:${ev.key} loc=${ev.locationId} matched=${matched} fired=${fired}`);
  }

  return { fired, matched };
}
