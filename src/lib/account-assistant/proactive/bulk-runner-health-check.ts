/**
 * Bulk Runner Health Check (F1.5, Pedro 2026-05-16).
 *
 * Roda em todo tick do cron sparkbot-proactive. Checa 2 coisas:
 *
 * 1. **Runner stale**: last_tick_at > 5min atrás. Indica que cron parou de
 *    rodar OU que fireBulkRecipients() está crashando antes do heartbeat
 *    final. Cria signal `bulk_runner_stale`.
 *
 * 2. **Jobs running stalled**: jobs com status='running' que têm recipients
 *    pending com scheduled_at < now - 10min, MAS sent_count não mudou nos
 *    últimos 30min. Indica que runner não consegue processar aquele job
 *    (erro silencioso, atomic claim falhando, etc).
 *
 * Caso Gustavo (2026-05-15→16): 3 jobs ficaram 21h running sem nenhum sent,
 * runner travado, sem alert. Esta função detectaria em <30min.
 *
 * Dedup: signals com mesmo title+source clusterizam (1 signal por hora
 * em vez de 1 a cada 30s). recordSignalAsync já faz isso.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { recordSignalAsync } from "@/lib/admin-signals/recorder";

export interface HealthCheckResult {
  runner_stale: boolean;
  stalled_jobs_count: number;
  alerts_created: number;
}

export async function checkBulkRunnerStaleAndAlert(): Promise<HealthCheckResult> {
  const supabase = createAdminClient();
  let alertsCreated = 0;

  // === Check 1: runner stale ===
  let runnerStale = false;
  try {
    const { data: health } = await supabase
      .from("bulk_runner_health")
      .select("last_tick_at, consecutive_errors, last_error")
      .eq("id", 1)
      .maybeSingle();

    if (health) {
      const lastTick = new Date(health.last_tick_at).getTime();
      const ageMs = Date.now() - lastTick;
      if (ageMs > 5 * 60 * 1000) {
        runnerStale = true;
        recordSignalAsync({
          type: "error",
          title: `bulk-runner: stale há ${Math.round(ageMs / 60000)}min`,
          description:
            `Runner não bate heartbeat há ${Math.round(ageMs / 60000)} minutos. ` +
            `Consecutive_errors: ${health.consecutive_errors ?? 0}. ` +
            `Last error: ${health.last_error || "nenhum"}.`,
          severity: "high",
          source: "bot_auto",
          metadata: {
            component: "bulk-message-runner",
            last_tick_at: health.last_tick_at,
            age_minutes: Math.round(ageMs / 60000),
          },
        });
        alertsCreated++;
      }
    }
  } catch (err) {
    console.warn("[bulk-health] check 1 (runner stale) falhou:", err);
  }

  // === Check 2: jobs running stalled ===
  // Procura jobs running com recipients pending vencidos há > 10min E
  // job não atualizado nos últimos 30min (sent_count parado).
  let stalledCount = 0;
  try {
    const cutoffStale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const cutoffOverdue = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // Jobs running sem update recente
    const { data: jobs } = await supabase
      .from("bulk_message_jobs")
      .select("id, rep_id, location_id, sent_count, total_contacts, updated_at, created_at")
      .eq("status", "running")
      .lt("updated_at", cutoffStale);

    for (const job of jobs || []) {
      // Tem pelo menos 1 recipient pending vencido?
      const { count: overdueCount } = await supabase
        .from("bulk_message_recipients")
        .select("id", { count: "exact", head: true })
        .eq("job_id", job.id)
        .eq("status", "pending")
        .lt("scheduled_at", cutoffOverdue);

      if ((overdueCount ?? 0) > 0) {
        stalledCount++;
        recordSignalAsync({
          type: "error",
          title: `bulk job ${job.id.slice(0, 8)}: stalled (${overdueCount} pending overdue)`,
          description:
            `Job running tem ${overdueCount} recipients overdue há >10min E sent_count (${job.sent_count}/${job.total_contacts}) parado há >30min. ` +
            `Provável: runner não está conseguindo enviar (Stevo down, GHL rate limit, ou bug em sendToContact).`,
          severity: "high",
          source: "bot_auto",
          metadata: {
            component: "bulk-message-runner",
            job_id: job.id,
            rep_id: job.rep_id,
            location_id: job.location_id,
            sent_count: job.sent_count,
            total_contacts: job.total_contacts,
            overdue_recipients: overdueCount,
            job_updated_at: job.updated_at,
          },
        });
        alertsCreated++;
      }
    }
  } catch (err) {
    console.warn("[bulk-health] check 2 (stalled jobs) falhou:", err);
  }

  return {
    runner_stale: runnerStale,
    stalled_jobs_count: stalledCount,
    alerts_created: alertsCreated,
  };
}
