/**
 * Runner de scheduled_tasks (lembretes do rep agendados via schedule_reminder).
 *
 * Roda dentro do cron principal (/api/cron/sparkbot-proactive). A cada 5min:
 *   1. Busca tasks com status='pending' AND next_run_at <= now() (limite 50)
 *   2. Pra cada task, atomic claim via update status='running' (anti-race)
 *   3. Dispara: insere agent_test_messages (se test_session_id) ou WhatsApp (V3)
 *   4. Update final:
 *        - one-shot: status='completed', last_run_at=now
 *        - recurring: calcula próximo next_run_at do cron, volta status='pending'
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { shouldFireCron } from "./cron-evaluator";

export interface ReminderRunResult {
  fired: number;
  failed: number;
  skipped: number;
}

interface ScheduledTaskRow {
  id: string;
  rep_id: string;
  location_id: string;
  task_type: string;
  task_payload: { message?: string; title?: string; test_session_id?: string | null };
  next_run_at: string;
  cron_expr: string | null;
  status: string;
  last_run_at: string | null;
}

export async function fireScheduledReminders(): Promise<ReminderRunResult> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Atomic claim: marca pending → running em uma só query
  const { data: claimed } = await supabase
    .from("assistant_scheduled_tasks")
    .update({ status: "running" })
    .eq("status", "pending")
    .lte("next_run_at", nowIso)
    .in("task_type", ["reminder", "recurring_reminder"])
    .select("*")
    .order("next_run_at", { ascending: true })
    .limit(50);

  if (!claimed || claimed.length === 0) {
    return { fired: 0, failed: 0, skipped: 0 };
  }

  let fired = 0;
  let failed = 0;
  let skipped = 0;

  for (const task of claimed as ScheduledTaskRow[]) {
    try {
      const result = await fireOne(task);
      if (result === "fired") fired++;
      else if (result === "skipped") skipped++;
      else failed++;
    } catch (err) {
      console.error(`[reminder-runner] task ${task.id} failed:`, err instanceof Error ? err.message : err);
      failed++;
      await markTaskFailed(task.id);
    }
  }

  return { fired, failed, skipped };
}

async function fireOne(task: ScheduledTaskRow): Promise<"fired" | "failed" | "skipped"> {
  const supabase = createAdminClient();
  const message = task.task_payload?.message;
  const title = task.task_payload?.title;
  const sessionId = task.task_payload?.test_session_id;

  if (!message) {
    await markTaskFailed(task.id);
    return "failed";
  }

  // V2 simulated: precisa de session_id pra mostrar no chat. Sem session,
  // marca como skipped (V3 vai usar WhatsApp direto, sem precisar disso).
  if (!sessionId) {
    // Tenta achar uma sessão de teste recente do rep pra entregar
    const { data: recentSession } = await supabase
      .from("agent_test_sessions")
      .select("id")
      .eq("location_id", task.location_id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!recentSession) {
      await advanceTask(task);
      return "skipped";
    }
    await deliverReminder(recentSession.id, task, message, title);
  } else {
    // Verifica se a sessão ainda existe
    const { data: sess } = await supabase
      .from("agent_test_sessions")
      .select("id")
      .eq("id", sessionId)
      .maybeSingle();
    if (!sess) {
      await advanceTask(task);
      return "skipped";
    }
    await deliverReminder(sessionId, task, message, title);
  }

  await advanceTask(task);
  return "fired";
}

async function deliverReminder(
  sessionId: string,
  task: ScheduledTaskRow,
  message: string,
  title: string | undefined,
): Promise<void> {
  const supabase = createAdminClient();
  // Formata como msg do agente com badge especial (igual aos alertas proativos)
  const text = `🔔 ${title || "Lembrete"}\n\n${message}`;
  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "agent",
    content: text,
    metadata: {
      alert_type: task.task_type === "recurring_reminder" ? "Lembrete recorrente" : "Lembrete",
      is_proactive: true,
      reminder_id: task.id,
      source: "scheduled_reminder",
    },
  });
  await supabase
    .from("agent_test_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);
}

/**
 * Avança o estado da task após disparo:
 *   - one-shot: marca como completed
 *   - recurring: calcula próximo next_run_at do cron e volta pra pending
 */
async function advanceTask(task: ScheduledTaskRow): Promise<void> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  if (task.task_type === "recurring_reminder" && task.cron_expr) {
    const nextRun = computeNextRun(task.cron_expr, new Date());
    if (!nextRun) {
      // Cron inválido — fail
      await supabase
        .from("assistant_scheduled_tasks")
        .update({ status: "failed", last_run_at: nowIso })
        .eq("id", task.id);
      return;
    }
    await supabase
      .from("assistant_scheduled_tasks")
      .update({
        status: "pending",
        last_run_at: nowIso,
        next_run_at: nextRun.toISOString(),
      })
      .eq("id", task.id);
  } else {
    await supabase
      .from("assistant_scheduled_tasks")
      .update({ status: "completed", last_run_at: nowIso })
      .eq("id", task.id);
  }
}

async function markTaskFailed(taskId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("assistant_scheduled_tasks")
    .update({ status: "failed", last_run_at: new Date().toISOString() })
    .eq("id", taskId);
}

/**
 * Calcula próximo trigger de um cron expression. Implementação simples por
 * iteração (incrementa minuto a minuto, máx 8 dias). Suficiente pra cron de
 * 5 campos com weekday/hour/minute simples.
 */
function computeNextRun(cron: string, from: Date): Date | null {
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1); // próximo minuto
  // Itera até 8 dias (cobre cron semanal)
  const maxIter = 8 * 24 * 60;
  for (let i = 0; i < maxIter; i++) {
    if (shouldFireCron(cron, "America/New_York", cursor)) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
