/**
 * Lembrete de tarefa do GHL (FORGE-3 2026-05-21 — P0 da proatividade).
 *
 * Event-driven: o webhook TASKCREATE/UPDATE chega (hoje era descartado) → agenda
 * um lembrete em `due − lead_min` (default 15, configurável por rep). Reusa
 * `assistant_scheduled_tasks` + `reminder-runner` (entrega ao REP via Stevo,
 * kind=nudge → sujeito ao silence-gate/anti-spam). TASKCOMPLETE/DELETE → cancela.
 *
 * Decisões (com o Pedro): task SEM due date → não lembra. Lembrete é 15min antes
 * (rep ajusta via chat `set_proactivity` ou na UI do Spark). "Tarefa atrasada" é
 * regra separada (default OFF) — não tratada aqui.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { RepIdentity } from "@/types/account-assistant";
import { resolveProactivityPref, taskReminderLeadMin } from "./preferences";

export interface TaskEvent {
  ghlTaskId: string;
  title: string | null;
  dueAt: string | null; // ISO
  assignedTo: string | null; // ghl user id (dono da task)
  contactId: string | null;
  locationId: string | null;
}

/**
 * Acha o rep dono da task pelo ghl_user_id (assignedTo). SEM efeito colateral —
 * NÃO cria rep (diferente de identifyRepByGhlUser): se o assignee não é um rep
 * SparkBot, retornamos null e o lembrete é pulado. Containment JSONB só por
 * ghl_user_id (cobre o rep em qualquer location).
 */
async function findRepByGhlUser(ghlUserId: string): Promise<RepIdentity | null> {
  const sb = createAdminClient();
  const { data } = await sb
    .from("rep_identities")
    .select("*")
    .filter("ghl_users", "cs", JSON.stringify([{ ghl_user_id: ghlUserId }]))
    .maybeSingle();
  return (data as RepIdentity | null) ?? null;
}

/** Cancela qualquer lembrete PENDENTE desta task (dedup de update/retry + conclusão). */
async function cancelPending(ghlTaskId: string): Promise<void> {
  const sb = createAdminClient();
  const { error } = await sb
    .from("assistant_scheduled_tasks")
    .update({ status: "cancelled" })
    .eq("task_type", "ghl_task_reminder")
    .eq("status", "pending")
    .filter("task_payload->>ghl_task_id", "eq", ghlTaskId);
  if (error) console.warn(`[task-reminder] cancel falhou (${ghlTaskId}): ${error.message}`);
}

/** Agenda (ou reagenda) o lembrete de uma task do GHL em due − lead_min. */
export async function scheduleTaskReminder(ev: TaskEvent): Promise<void> {
  if (!ev.ghlTaskId) return;

  // D3: sem due date → não lembra.
  if (!ev.dueAt) {
    console.log(`[task-reminder] task ${ev.ghlTaskId} sem dueDate — não agenda`);
    return;
  }
  const dueMs = Date.parse(ev.dueAt);
  if (!Number.isFinite(dueMs)) {
    console.log(`[task-reminder] task ${ev.ghlTaskId} dueDate inválido (${ev.dueAt}) — skip`);
    return;
  }
  if (!ev.assignedTo) {
    console.log(`[task-reminder] task ${ev.ghlTaskId} sem assignedTo — não dá pra achar o rep`);
    return;
  }

  const rep = await findRepByGhlUser(ev.assignedTo);
  if (!rep) {
    console.log(`[task-reminder] assignedTo ${ev.assignedTo} não é rep SparkBot — skip`);
    return;
  }

  const pref = resolveProactivityPref(rep, "task_reminder");
  if (!pref.enabled) {
    console.log(`[task-reminder] rep ${rep.id} com task_reminder OFF — skip`);
    return;
  }

  const leadMin = taskReminderLeadMin(rep);
  const fireMs = dueMs - leadMin * 60_000;
  if (fireMs <= Date.now()) {
    // Vence em menos de lead_min (ou já venceu) → não faz sentido o "X min antes".
    console.log(`[task-reminder] task ${ev.ghlTaskId} fire no passado (vence cedo demais) — skip`);
    return;
  }

  // Reagendamento idempotente: cancela o pendente antigo antes de inserir o novo.
  await cancelPending(ev.ghlTaskId);

  const titleTxt = (ev.title || "").trim() || "(sem título)";
  const message =
    `⏰ Lembrete: a tarefa "${titleTxt}" vence em ~${leadMin}min. ` +
    `Quer que eu marque como concluída, adie ou veja os detalhes?`;

  const sb = createAdminClient();
  const { error } = await sb.from("assistant_scheduled_tasks").insert({
    rep_id: rep.id,
    location_id: ev.locationId || rep.active_location_id || "",
    task_type: "ghl_task_reminder",
    task_payload: {
      message,
      title: titleTxt,
      source: "ghl_task",
      ghl_task_id: ev.ghlTaskId,
      contact_id: ev.contactId ?? null,
      due_at: ev.dueAt,
    },
    next_run_at: new Date(fireMs).toISOString(),
    status: "pending",
  });
  if (error) {
    console.warn(`[task-reminder] insert falhou (${ev.ghlTaskId}): ${error.message}`);
    return;
  }
  console.log(
    `[task-reminder] agendado rep=${rep.id} task=${ev.ghlTaskId} ` +
      `fire=${new Date(fireMs).toISOString()} (lead ${leadMin}min)`,
  );
}

/** Cancela o lembrete pendente quando a task é concluída/apagada no GHL. */
export async function cancelTaskReminder(ghlTaskId: string): Promise<void> {
  if (!ghlTaskId) return;
  await cancelPending(ghlTaskId);
  console.log(`[task-reminder] lembrete da task ${ghlTaskId} cancelado`);
}
