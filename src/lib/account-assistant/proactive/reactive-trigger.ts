/**
 * Reactive trigger — F27.D (Pedro 2026-05-29; custom field 2026-07-06).
 *
 * Quando o GHL/Spark Leads notifica "tag adicionada", "lead entrou em estágio"
 * ou "custom field mudou", esse módulo:
 *  1. Lista agentes lead-facing ATIVOS da location.
 *  2. Filtra os que têm `targeting_rules` que bate com o evento.
 *  3. Pra cada match, enfileira UMA mensagem "trigger sintético" em
 *     `message_queue`. O queue-processor reconhece pelo prefix do body
 *     e gera 1ª mensagem proativa (sem esperar lead mandar nada).
 *
 * Idempotência: antes de disparar, consulta `execution_log` últimas 24h
 * com `action_type='reactive_trigger_fired'`. Se mesmo (agent, contact,
 * event_key) já fired = skip. Evita disparo em loop quando o evento
 * (tag/campo) é reenviado várias vezes.
 *
 * Custom field (Pedro 2026-07-06 — caso Alves Cury): o `CONTACTUPDATE` do GHL
 * chega com TODOS os customFields (valor ATUAL, sem diff antes/depois). Por isso
 * o disparo por custom field tem uma guarda EXTRA além do dedup de 24h: só
 * dispara se o contato ainda NÃO tem conversa com esse agente. Senão um
 * ContactUpdate solto de um contato já em atendimento re-abriria a conversa do
 * zero. O caso "lead falou antes da IA ligar" NÃO tem conversation_state (o
 * inbound foi descartado no targeting), então passa a guarda e o agente
 * "continua" via lead_history.
 *
 * Diferente do `reaction-engine.ts` (POST-LLM, reage a `on_data_field_set`),
 * esse é PRE-LLM: dispara o agente do zero quando webhook GHL chega.
 *
 * Gate: roda só quando `isProactiveEventsEnabled()` (env
 * `PROACTIVE_EVENTS_ENABLED`) e, se `PROACTIVE_EVENTS_LOCATIONS` estiver setado,
 * só pras locations da allowlist (escopo de rollout — ver event-router).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeTargeting } from "@/lib/queue/targeting";
import type { TargetingRule, TargetingRules } from "@/types/agent";

const REACTIVE_TRIGGER_PREFIX = "__reactive_trigger__:";

export type ReactiveTriggerKind =
  | "tag_added"
  | "tag_removed"
  | "stage_changed"
  | "contact_created"
  | "custom_field_changed";

export interface ReactiveTriggerContext {
  locationId: string;
  contactId: string;
  kind: ReactiveTriggerKind;
  /** Para tag_*: o nome da tag. Para stage_changed: o ID do estágio. Vazio p/ custom_field. */
  key: string;
  /** Para stage_changed: o pipeline ID (opcional). */
  pipelineId?: string;
  /** Para custom_field_changed: os customFields ATUAIS do contato {id, value}.
   *  Cada agente casa o SEU (custom_field_key + custom_field_value). */
  customFields?: Array<{ id: string; value: string }>;
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
  // v2 (Pedro 2026-06-17): targeting_rules pode ser array legado OU set v2 com
  // grupos E/OU. Achata pra folhas — matchedTriggerKey casa tag/pipeline_stage/
  // custom_field (ignora message, que não tem trigger reativo por evento).
  const set = normalizeTargeting((cfg?.targeting_rules ?? null) as TargetingRules | null);
  const rules: TargetingRule[] = set ? set.groups.flatMap((g) => g.rules) : [];
  return {
    rules,
    outreachOn: !!(cfg?.outreach_config as { enabled?: boolean } | null)?.enabled,
  };
}

/**
 * Devolve a CHAVE de dedup do evento se ALGUMA regra do agente casa, senão null.
 * A chave é específica da regra que disparou (tag / estágio / campo:valor), pra
 * o dedup de 24h não confundir gatilhos diferentes do mesmo contato.
 *
 *  - tag_added "VIP" + rule {type:"tag", tag:"VIP"} -> "tag_added:VIP"
 *  - stage_changed "stageX" + rule {type:"pipeline_stage", pipeline_stage_id:"stageX"} -> "stage_changed:stageX"
 *  - custom_field_changed + rule {type:"custom_field", key:AI, value:"Venda"} e o
 *    contato tem esse campo com esse valor -> "custom_field_changed:AI:Venda"
 *    (valor vazio na regra = "qualquer valor")
 *  - rules vazias / nenhum match -> null
 */
export function matchedTriggerKey(rules: TargetingRule[], ev: ReactiveTriggerContext): string | null {
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    if (ev.kind === "tag_added" && rule.type === "tag" && rule.tag && ev.key === rule.tag) {
      return `tag_added:${rule.tag}`;
    }
    if (
      ev.kind === "stage_changed" &&
      rule.type === "pipeline_stage" &&
      rule.pipeline_stage_id &&
      ev.key === rule.pipeline_stage_id &&
      (!rule.pipeline_id || !ev.pipelineId || rule.pipeline_id === ev.pipelineId)
    ) {
      return `stage_changed:${rule.pipeline_stage_id}`;
    }
    if (ev.kind === "custom_field_changed" && rule.type === "custom_field" && rule.custom_field_key) {
      const hit = (ev.customFields || []).find((f) => f.id === rule.custom_field_key);
      if (hit) {
        const wanted = (rule.custom_field_value ?? "").trim();
        if (!wanted || wanted === (hit.value ?? "").trim()) {
          return `custom_field_changed:${rule.custom_field_key}:${hit.value}`;
        }
      }
    }
  }
  return null;
}

/** Back-compat: booleano de match (delega pra matchedTriggerKey). */
export function ruleMatchesTrigger(rules: TargetingRule[], ev: ReactiveTriggerContext): boolean {
  return matchedTriggerKey(rules, ev) !== null;
}

function eventKey(ev: ReactiveTriggerContext): string {
  return `${ev.kind}:${ev.key}${ev.pipelineId ? `:${ev.pipelineId}` : ""}`;
}

/**
 * Encode do trigger no body da queue. queue-processor detecta o prefix e
 * gera 1ª msg proativa. Pra custom_field o body é GENÉRICO (a abertura NÃO cita
 * o campo/valor); o valor específico fica só no dedup key, não no body.
 */
export function encodeTriggerBody(ev: ReactiveTriggerContext): string {
  if (ev.kind === "custom_field_changed") return `${REACTIVE_TRIGGER_PREFIX}custom_field_changed:activated`;
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
 * Idempotência: checa se mesmo (agent, contact, dedupKey) já foi disparado
 * nas últimas 24h. Usa execution_log como audit + cache.
 */
async function alreadyFired(
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string,
  contactId: string,
  dedupKey: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("execution_log")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .eq("action_type", "reactive_trigger_fired")
    .gte("created_at", cutoff)
    .contains("action_payload", { event_key: dedupKey });
  return (count ?? 0) > 0;
}

/**
 * Guarda anti-reabertura (só custom_field): não dispara proativo se o contato
 * JÁ tem conversa com esse agente. Ver bloco de doc no topo.
 */
async function hasConversation(
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string,
  contactId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("conversation_state")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId);
  return (count ?? 0) > 0;
}

/**
 * Dispara o(s) agente(s) que devem reagir a esse evento.
 * Retorna count de triggers enfileirados.
 */
export async function triggerReactiveAgents(ev: ReactiveTriggerContext): Promise<{ fired: number; matched: number }> {
  if (!ev.contactId || !ev.locationId) return { fired: 0, matched: 0 };
  // custom_field precisa dos campos; os demais precisam de key.
  if (ev.kind === "custom_field_changed") {
    if (!ev.customFields || ev.customFields.length === 0) return { fired: 0, matched: 0 };
  } else if (!ev.key) {
    return { fired: 0, matched: 0 };
  }
  const supabase = createAdminClient();

  // Lista agentes lead-facing ATIVOS da location (rep-facing/SparkBot ignorado —
  // não tem targeting nem opera por evento de tag/campo de lead).
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
    const dedupKey = matchedTriggerKey(rules, ev);
    if (!dedupKey) continue;
    matched++;

    // Guarda anti-reabertura (custom_field): não re-abre contato já em conversa.
    if (ev.kind === "custom_field_changed" && (await hasConversation(supabase, a.id, ev.contactId))) continue;

    if (await alreadyFired(supabase, a.id, ev.contactId, dedupKey)) continue;

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
      action_payload: { event_key: dedupKey, kind: ev.kind, key: ev.key, pipeline_id: ev.pipelineId || null },
      success: true,
    });

    fired++;
  }

  if (matched > 0) {
    console.log(`[reactive-trigger] ${ev.kind} loc=${ev.locationId} matched=${matched} fired=${fired}`);
  }

  return { fired, matched };
}
