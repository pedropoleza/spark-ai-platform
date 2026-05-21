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
  // Etapa 4 (ainda só logados): OPPORTUNITY*/APPOINTMENT*/CONTACT*.
  "OPPORTUNITYSTATUSUPDATE",
  "OPPORTUNITYSTAGEUPDATE",
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

  // OPPORTUNITY*/APPOINTMENT*/CONTACT*: Etapa 4. Por ora só o log acima (observa
  // o payload pra implementar deal_won/novo lead/briefing/no-show com segurança).
}
