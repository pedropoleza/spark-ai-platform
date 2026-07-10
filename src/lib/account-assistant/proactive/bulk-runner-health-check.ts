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
  reps_notified?: number;
  /** H49-F5: jobs PAUSADOS há >24h com pendentes (esquecidos). */
  paused_forgotten_count?: number;
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
          // Triagem 2026-06-17: título ESTÁVEL — minutos vão só na description.
          // Antes embutia ${min} no título → fingerprint(type+title) novo a cada
          // minuto → 1 runner parado virava N rows no painel.
          title: `bulk-runner: heartbeat parado (stale)`,
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
  // Track de reps a notificar (dedup por rep+job pra não notificar 5x se 5 jobs travam)
  const repsToNotify = new Map<string, { reps: Set<string>; jobs: Map<string, string[]> }>();
  try {
    const cutoffStale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const cutoffOverdue = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // Jobs running sem update recente
    const { data: jobs } = await supabase
      .from("bulk_message_jobs")
      .select("id, rep_id, location_id, sent_count, total_contacts, updated_at, created_at, label")
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
          // Triagem 2026-06-17: título ESTÁVEL por job (sem a contagem dinâmica).
          // Antes embutia (${overdueCount} pending overdue) → como recipients
          // drenam tick a tick (17→11→...→1), cada contagem virava um row novo
          // (1 job stalled gerou ~11 sinais). Contagem fica na description+metadata.
          title: `bulk job ${job.id.slice(0, 8)}: stalled (pending overdue)`,
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

        // Pedro 2026-05-16: track rep pra notificar também via WhatsApp
        const locBucket = repsToNotify.get(job.location_id) ?? { reps: new Set(), jobs: new Map() };
        locBucket.reps.add(job.rep_id);
        const repJobs = locBucket.jobs.get(job.rep_id) ?? [];
        repJobs.push(job.label || `${job.id.slice(0, 8)} (${overdueCount} pending)`);
        locBucket.jobs.set(job.rep_id, repJobs);
        repsToNotify.set(job.location_id, locBucket);
      }
    }
  } catch (err) {
    console.warn("[bulk-health] check 2 (stalled jobs) falhou:", err);
  }

  // === Check 3: notifica REPS afetados via WhatsApp ===
  // Pedro 2026-05-16: além do signal admin, manda msg pro rep avisando que
  // o disparo dele tá travado e o admin já foi notificado. Dedup: 1 notif
  // por rep a cada 30min (em rep_identities.profile.bulk_stall_notified_at).
  let repsNotified = 0;
  try {
    if (repsToNotify.size > 0) {
      const { notifyRepsAboutStalledJobs } = await import("./bulk-runner-rep-notifier");
      repsNotified = await notifyRepsAboutStalledJobs(repsToNotify);
    }
  } catch (err) {
    console.warn("[bulk-health] rep notification falhou:", err);
  }

  // === Check 4: jobs PAUSADOS e esquecidos (H49-F5, post-mortem Jussara 2026-07-03) ===
  // Job 'paused' com pendentes há >24h não avisava NINGUÉM — os 5 pendentes da
  // Jussara ficaram 7 dias parados em silêncio. Avisa o REP (1× por job+paused_at,
  // marker no profile; re-pausar → novo aviso) + admin signal, perguntando o que
  // fazer (retomar / cancelar / trocar o texto).
  let pausedForgotten = 0;
  try {
    const cutoffPaused = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: pausedJobs } = await supabase
      .from("bulk_message_jobs")
      .select("id, rep_id, location_id, label, paused_at, sent_count, total_contacts")
      .eq("status", "paused")
      .lt("paused_at", cutoffPaused)
      .limit(20);

    for (const job of pausedJobs || []) {
      const { count: pendingCount } = await supabase
        .from("bulk_message_recipients")
        .select("id", { count: "exact", head: true })
        .eq("job_id", job.id)
        .eq("status", "pending");
      if ((pendingCount ?? 0) === 0) continue;
      pausedForgotten++;

      const { data: repRow } = await supabase
        .from("rep_identities")
        .select("id, phone, profile, last_inbound_at, active_location_id")
        .eq("id", job.rep_id)
        .maybeSingle();
      if (!repRow) continue;
      const profileFull = (repRow.profile || {}) as Record<string, unknown>;
      const notifiedMap = (profileFull.paused_jobs_notified || {}) as Record<string, string>;
      if (notifiedMap[job.id] === job.paused_at) continue; // já avisado DESSA pausa

      recordSignalAsync({
        type: "failure",
        title: `bulk job ${job.id.slice(0, 8)}: pausado e esquecido (pendentes)`,
        description:
          `Job pausado desde ${job.paused_at} com ${pendingCount} recipients pending ` +
          `(${job.sent_count}/${job.total_contacts} enviados). Rep foi notificado pra decidir retomar/cancelar/trocar texto.`,
        severity: "medium",
        source: "bot_auto",
        metadata: {
          component: "bulk-message-runner",
          job_id: job.id,
          rep_id: job.rep_id,
          location_id: job.location_id,
          pending_recipients: pendingCount,
          paused_at: job.paused_at,
        },
      });
      alertsCreated++;

      const pausedDays = Math.max(1, Math.round((Date.now() - new Date(job.paused_at).getTime()) / 86400000));
      const label = job.label || job.id.slice(0, 8);
      const { deliverProactiveMessage } = await import("./whatsapp-delivery");
      const res = await deliverProactiveMessage(
        { id: repRow.id, phone: repRow.phone, last_inbound_at: repRow.last_inbound_at },
        `⏸️ Só lembrando: seu disparo *"${label}"* tá pausado há ${pausedDays} dia(s) e *${pendingCount} contato(s)* ainda não receberam (${job.sent_count}/${job.total_contacts} enviados). Me fala o que prefere: *"retoma o disparo"*, *"cancela o disparo"*, ou me manda um texto novo que eu troco antes de retomar. 👍`,
        {
          activeLocationId: repRow.active_location_id,
          source: "bulk_paused_reminder",
          kind: "bulk_paused_reminder",
          extraMetadata: { job_id: job.id },
        },
      );
      if (res.ok) {
        repsNotified++;
        // Merge defensivo do profile (mesmo padrão do rep-notifier C1).
        await supabase
          .from("rep_identities")
          .update({ profile: { ...profileFull, paused_jobs_notified: { ...notifiedMap, [job.id]: job.paused_at } } })
          .eq("id", repRow.id);
      }
    }
  } catch (err) {
    console.warn("[bulk-health] check 4 (paused forgotten) falhou:", err);
  }

  return {
    runner_stale: runnerStale,
    stalled_jobs_count: stalledCount,
    alerts_created: alertsCreated,
    reps_notified: repsNotified,
    paused_forgotten_count: pausedForgotten,
  };
}
