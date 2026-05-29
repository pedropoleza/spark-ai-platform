/**
 * Roteador de eventos proativos (FORGE-3 2026-05-21 — P0).
 *
 * Descoberta do diagnóstico: o GHL JÁ manda webhooks de TASK / OPPORTUNITY /
 * APPOINTMENT / CONTACT pro nosso endpoint de inbound — e a gente DESCARTA hoje
 * (isRealMessage → invalidTypes). Em vez de descartar, este roteador capta o
 * evento e dispara a proatividade event-driven correspondente.
 *
 * Segurança:
 *  - Gated por env PROACTIVE_EVENTS_ENABLED (default OFF → comportamento idêntico
 *    ao de hoje). Deployar não muda nada até ligar no smoke supervisionado.
 *  - Non-fatal / fire-and-forget: chamado com void+catch no webhook; NUNCA bloqueia
 *    nem quebra o fluxo de mensagem (o isRealMessage segue descartando depois).
 *  - Log-first: loga o payload (verifica o shape real do webhook — D4) antes de agir.
 *
 * P0: só eventos de TASK (lembrete de tarefa). Opp/Appointment/Contact entram na
 * Etapa 4 (deal_won, novo lead, briefing, no-show) — por ora só logados.
 */

import { scheduleTaskReminder, cancelTaskReminder, type TaskEvent } from "./task-reminders";
// F27.D (Pedro 2026-05-29): trigger reativo de agentes lead-facing por tag/stage.
import { triggerReactiveAgents, type ReactiveTriggerContext } from "./reactive-trigger";

/** Gate global da proatividade event-driven. Default OFF. */
export function isProactiveEventsEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PROACTIVE_EVENTS_ENABLED?.trim() || "");
}

/** Tipos de webhook que NÃO são mensagem mas interessam à proatividade. */
const PROACTIVE_EVENT_TYPES = new Set([
  "TASKCREATE",
  "TASKUPDATE",
  "TASKCOMPLETE",
  "TASKDELETE",
  // F27.D (Pedro 2026-05-29): wire de trigger reativo (CONTACTTAGUPDATE e
  // OPPORTUNITYSTAGEUPDATE) pra agentes lead-facing com targeting_rules.
  // Antes só logados — agora roteados pra reactive-trigger.ts.
  "CONTACTTAGUPDATE",
  "OPPORTUNITYSTAGEUPDATE",
  // Etapa 4 (ainda só logados): demais eventos de OPPORTUNITY*/APPOINTMENT*/CONTACT*.
  "OPPORTUNITYSTATUSUPDATE",
  "APPOINTMENTCREATE",
  "APPOINTMENTUPDATE",
  "CONTACTCREATE",
]);

export function isProactiveEventType(messageType: string): boolean {
  return PROACTIVE_EVENT_TYPES.has((messageType || "").toUpperCase());
}

// ── coerção defensiva (payload do GHL varia entre webhook nativo/workflow) ──
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** Extrai os campos da task de um body de webhook (defensivo). */
function extractTaskEvent(body: Record<string, unknown>): TaskEvent | null {
  const task = { ...asRecord(body.task ?? body.Task), ...body };
  const ghlTaskId = pickStr(task, "id", "taskId", "task_id");
  if (!ghlTaskId) return null;
  return {
    ghlTaskId,
    title: pickStr(task, "title", "name", "body"),
    dueAt: pickStr(task, "dueDate", "due_date", "dueAt", "due"),
    assignedTo: pickStr(task, "assignedTo", "assigned_to", "userId", "user_id"),
    contactId: pickStr(task, "contactId", "contact_id"),
    locationId: pickStr(task, "locationId", "location_id"),
  };
}

/**
 * Roteia um evento (não-mensagem) pra proatividade. Idempotente o suficiente:
 * o agendamento de task cancela o pendente antes de reinserir.
 */
export async function routeProactiveEvent(
  body: Record<string, unknown>,
  messageType: string,
): Promise<void> {
  const type = (messageType || "").toUpperCase();

  // Log-first: revela o shape real do payload (verifica D4 no smoke).
  console.log(`[proactive-router] evento ${type}: ${JSON.stringify(body).slice(0, 600)}`);

  if (type === "TASKCREATE" || type === "TASKUPDATE") {
    const ev = extractTaskEvent(body);
    if (ev) await scheduleTaskReminder(ev);
    return;
  }
  if (type === "TASKCOMPLETE" || type === "TASKDELETE") {
    const ev = extractTaskEvent(body);
    if (ev) await cancelTaskReminder(ev.ghlTaskId);
    return;
  }

  // F27.D (Pedro 2026-05-29) — trigger reativo de agentes lead-facing.
  if (type === "CONTACTTAGUPDATE") {
    const ev = extractContactTagEvent(body);
    if (ev) await triggerReactiveAgents(ev);
    return;
  }
  if (type === "OPPORTUNITYSTAGEUPDATE") {
    const ev = extractOpportunityStageEvent(body);
    if (ev) await triggerReactiveAgents(ev);
    return;
  }

  // OPPORTUNITY*/APPOINTMENT*/CONTACT*: Etapa 4. Por ora só o log acima (observa
  // o payload pra implementar deal_won/novo lead/briefing/no-show com segurança).
}

/**
 * F27.D — Extrai evento "tag adicionada" do payload. Shape do GHL pode variar:
 *  - tags: array de strings (nova lista completa)
 *  - addedTag / addedTags: tag específica adicionada
 *  - tag: campo único (legacy)
 *
 * Estratégia: pega a tag MAIS RECENTE adicionada se disponível, senão usa
 * a 1ª tag da lista (limitação aceitável — webhook GHL geralmente dispara
 * 1 por mudança).
 */
function extractContactTagEvent(body: Record<string, unknown>): ReactiveTriggerContext | null {
  const contactId = pickStr(body, "contactId", "contact_id", "id");
  const locationId = pickStr(body, "locationId", "location_id");
  if (!contactId || !locationId) return null;

  // Tag específica adicionada (preferido)
  const addedTag =
    pickStr(body, "addedTag", "added_tag", "newTag", "new_tag") ||
    (Array.isArray(body.addedTags) ? String((body.addedTags as unknown[])[0] || "") : null) ||
    (Array.isArray(body.added_tags) ? String((body.added_tags as unknown[])[0] || "") : null);

  // Fallback: pega tag da lista (assume "última" como adicionada)
  let key = addedTag;
  if (!key && Array.isArray(body.tags) && (body.tags as unknown[]).length > 0) {
    const arr = body.tags as unknown[];
    const last = arr[arr.length - 1];
    key = typeof last === "string" ? last : (last as { name?: string })?.name || null;
  }
  if (!key || !key.trim()) return null;

  return { locationId, contactId, kind: "tag_added", key: key.trim() };
}

/**
 * F27.D — Extrai evento "lead entrou em estágio" do payload. Shape comum:
 *  - pipelineStageId / pipeline_stage_id (atual)
 *  - pipelineId / pipeline_id (atual)
 *  - opportunity: { pipelineStageId, pipelineId }
 */
function extractOpportunityStageEvent(body: Record<string, unknown>): ReactiveTriggerContext | null {
  const opp = asRecord(body.opportunity ?? body.Opportunity);
  const merged = { ...opp, ...body };

  const contactId = pickStr(merged, "contactId", "contact_id");
  const locationId = pickStr(merged, "locationId", "location_id");
  const stageId = pickStr(merged, "pipelineStageId", "pipeline_stage_id", "stageId", "stage_id");
  const pipelineId = pickStr(merged, "pipelineId", "pipeline_id") || undefined;

  if (!contactId || !locationId || !stageId) return null;
  return { locationId, contactId, kind: "stage_changed", key: stageId, pipelineId };
}
