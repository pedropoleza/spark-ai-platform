/**
 * Runner de bulk_message_recipients.
 *
 * Roda dentro do cron principal (/api/cron/sparkbot-proactive) a cada 30s.
 * Pra cada tick:
 *   1. Atomic claim de até MAX_PER_TICK recipients pending com
 *      scheduled_at <= now() (status='pending' → 'sending').
 *   2. Pra cada claim:
 *      a. Se job.status != 'running' (pause/cancel) → marca skipped, segue.
 *      b. Se respect_quiet_hours=true e estamos dentro quiet_hours do agent
 *         → reverte pra pending (será reprocessado próximo tick).
 *      c. Gera variation via Haiku (se variation_mode != 'none').
 *      d. Envia via GHL conversations/messages (canal por job).
 *      e. Marca status='sent' ou 'failed' + grava actual_message + sent_at.
 *   3. Atualiza counters do job. Se todos recipients !pending, marca
 *      job.status='completed'.
 *
 * Cap defensivo: MAX_PER_TICK=5. Pra 100 contatos a 90s de drip, 30s tick
 * geralmente pega 0-1 por tick — limite só afeta backlog (ex: voltar de
 * quiet_hours com 8h de fila).
 *
 * Silence gate: NÃO se aplica aqui — msg vai pro CONTATO, não pro rep.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { generateVariation } from "./bulk-message-variator";

const MAX_PER_TICK = 5;

export interface BulkRunResult {
  fired: number;
  failed: number;
  skipped: number;
  jobs_completed: number;
}

interface BulkRecipientRow {
  id: string;
  job_id: string;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  scheduled_at: string;
  status: string;
}

interface BulkJobRow {
  id: string;
  rep_id: string;
  location_id: string;
  agent_id: string | null;
  message_template: string;
  variation_mode: "none" | "light" | "medium";
  delivery_channel: "whatsapp_web_sms" | "whatsapp_api";
  respect_quiet_hours: boolean;
  status: string;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
}

export async function fireBulkRecipients(): Promise<BulkRunResult> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Atomic claim: pega até MAX_PER_TICK pending vencidos. Update SQL atomic
  // marca como 'sending'. Mesmo padrão do reminder-runner.
  const { data: claimedRaw } = await supabase
    .from("bulk_message_recipients")
    .update({ status: "sending" })
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .select("*")
    .order("scheduled_at", { ascending: true })
    .limit(MAX_PER_TICK);

  const claimed = (claimedRaw || []) as BulkRecipientRow[];
  if (claimed.length === 0) {
    return { fired: 0, failed: 0, skipped: 0, jobs_completed: 0 };
  }

  // Hidrata jobs (1 query batch)
  const jobIds = Array.from(new Set(claimed.map((r) => r.job_id)));
  const { data: jobsData } = await supabase
    .from("bulk_message_jobs")
    .select("*")
    .in("id", jobIds);
  const jobsById = new Map<string, BulkJobRow>(
    (jobsData || []).map((j) => [j.id as string, j as BulkJobRow]),
  );

  let fired = 0;
  let failed = 0;
  let skipped = 0;
  const touchedJobIds = new Set<string>();

  for (const recipient of claimed) {
    const job = jobsById.get(recipient.job_id);
    if (!job) {
      // Job sumiu (cancelado e deletado em algum lugar?) — marca skipped.
      await markRecipientSkipped(recipient.id, "job_not_found");
      skipped++;
      continue;
    }
    touchedJobIds.add(job.id);

    // Job pausado/cancelado/completado — marca skipped sem enviar.
    // Pause: rep pode resumir, então recipients ficam skipped até essa hora.
    // Pra retomar via resume_bulk_job, criamos novo job ou ressetamos.
    if (job.status === "paused") {
      // Volta pra pending — quando resume, processa de novo.
      await supabase
        .from("bulk_message_recipients")
        .update({ status: "pending" })
        .eq("id", recipient.id);
      skipped++;
      continue;
    }
    if (job.status !== "running") {
      // cancelled / completed / failed — marca skipped definitivo.
      await markRecipientSkipped(recipient.id, `job_status_${job.status}`);
      skipped++;
      continue;
    }

    // Quiet hours check (snapshot do agent_configs no momento de cada tick)
    if (job.respect_quiet_hours) {
      const inQuiet = await isInQuietHours(job.agent_id);
      if (inQuiet) {
        // Volta pra pending, próximo tick re-tenta. Loop até sair do quiet.
        await supabase
          .from("bulk_message_recipients")
          .update({ status: "pending" })
          .eq("id", recipient.id);
        skipped++;
        continue;
      }
    }

    // Gera variation
    let messageToSend: string;
    try {
      messageToSend = await generateVariation(
        job.message_template,
        job.variation_mode,
        recipient.contact_name,
      );
    } catch (err) {
      console.warn(
        `[bulk-runner] variation falhou pra recipient ${recipient.id}, usando template direto:`,
        err instanceof Error ? err.message : err,
      );
      messageToSend = job.message_template;
    }

    // Envia via GHL
    const result = await sendToContact(job, recipient, messageToSend);
    if (result.ok) {
      await supabase
        .from("bulk_message_recipients")
        .update({
          status: "sent",
          actual_message: messageToSend,
          sent_at: new Date().toISOString(),
        })
        .eq("id", recipient.id);
      fired++;
    } else {
      await supabase
        .from("bulk_message_recipients")
        .update({
          status: "failed",
          actual_message: messageToSend,
          error_message: result.error || "envio falhou",
        })
        .eq("id", recipient.id);
      failed++;
    }
  }

  // Atualiza counters dos jobs tocados + marca completed se acabou
  let jobsCompleted = 0;
  for (const jobId of touchedJobIds) {
    const completed = await refreshJobCounters(jobId);
    if (completed) jobsCompleted++;
  }

  return { fired, failed, skipped, jobs_completed: jobsCompleted };
}

async function markRecipientSkipped(
  recipientId: string,
  reason: string,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("bulk_message_recipients")
    .update({ status: "skipped", error_message: reason })
    .eq("id", recipientId);
}

/**
 * Checa se estamos dentro do quiet_hours configurado no agent.
 * Lógica idêntica à do dispatcher.ts (mas standalone aqui pra evitar
 * import circular). Se agent_id null ou config faltando → false (sem quiet).
 */
async function isInQuietHours(agentId: string | null): Promise<boolean> {
  if (!agentId) return false;
  const supabase = createAdminClient();
  const { data: config } = await supabase
    .from("agent_configs")
    .select("quiet_hours")
    .eq("agent_id", agentId)
    .maybeSingle();
  type QuietHours = {
    enabled?: boolean;
    timezone?: string;
    start?: string;
    end?: string;
    days?: number[];
  };
  const qh = (config?.quiet_hours || null) as QuietHours | null;
  if (!qh || !qh.enabled) return false;

  const tz = qh.timezone || "America/New_York";
  const start = qh.start || "22:00";
  const end = qh.end || "07:00";
  const days = qh.days || [0, 1, 2, 3, 4, 5, 6];

  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const weekday = weekdayMap[get("weekday")] ?? 0;
    if (!days.includes(weekday)) return false;
    const hour = parseInt(get("hour")) || 0;
    const minute = parseInt(get("minute")) || 0;
    const nowMin = hour * 60 + minute;
    const [sH, sM] = start.split(":").map(Number);
    const [eH, eM] = end.split(":").map(Number);
    const startMin = sH * 60 + sM;
    const endMin = eH * 60 + eM;
    if (startMin > endMin) return nowMin >= startMin || nowMin <= endMin;
    return nowMin >= startMin && nowMin <= endMin;
  } catch {
    return false;
  }
}

/**
 * Envia msg pro contato via GHL conversations/messages.
 * Type mapping:
 *   - 'whatsapp_web_sms' → type: "SMS" (Stevo/Evolution roteia pro WhatsApp)
 *   - 'whatsapp_api' → type: "WhatsApp"
 */
async function sendToContact(
  job: BulkJobRow,
  recipient: BulkRecipientRow,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = createAdminClient();
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", job.location_id)
      .maybeSingle();
    if (!location) {
      return { ok: false, error: "location não sincronizada" };
    }
    const ghlClient = new GHLClient(location.company_id, job.location_id);
    const ghlType = job.delivery_channel === "whatsapp_api" ? "WhatsApp" : "SMS";

    // Fix Pedro 2026-05-06: PROTOCOLO PADRÃO — antes de QUALQUER send,
    // garante que assignedTo é o rep que criou o job. Em contas com
    // múltiplas instâncias WhatsApp ativas, GHL roteia outbound baseado
    // no assignedTo do contato. Sem isso, mensagem em massa pode sair
    // pelo número de outro rep da agency, confundindo recipientes.
    try {
      const { data: rep } = await supabase
        .from("rep_identities")
        .select("ghl_users")
        .eq("id", job.rep_id)
        .maybeSingle();
      const repGhlUserId = (
        (rep?.ghl_users as Array<{ ghl_user_id: string; location_id: string }>) || []
      ).find((u) => u.location_id === job.location_id)?.ghl_user_id;
      if (repGhlUserId) {
        const { ensureContactAssignedTo } = await import("@/lib/ghl/operations");
        await ensureContactAssignedTo(ghlClient, recipient.contact_id, repGhlUserId);
      }
    } catch (assignErr) {
      // Não fatal — segue. (Pra recipient com 100s/1000s de msgs, esse
      // hit no GHL é aceitável: 1 extra GET + ocasional PUT por contato.)
      console.warn(
        `[bulk-runner] assignedTo update falhou pra contact=${recipient.contact_id}:`,
        assignErr instanceof Error ? assignErr.message.slice(0, 100) : assignErr,
      );
    }

    await ghlClient.post("/conversations/messages", {
      type: ghlType,
      contactId: recipient.contact_id,
      message,
    });
    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg.slice(0, 500) };
  }
}

/**
 * Recalcula sent_count / failed_count / skipped_count do job.
 * Se todos os recipients estão completados (sent + failed + skipped + cancelled),
 * marca job.status='completed' e completed_at=now.
 *
 * Returns true se job foi marcado completed nesta call.
 */
async function refreshJobCounters(jobId: string): Promise<boolean> {
  const supabase = createAdminClient();

  // Fix Track 7 M3 (review 2026-05-05): antes fazia 6 queries (head count
  // por status). Agora 1 query select all rows + agregação JS. Em scale,
  // 50 jobs × 6 queries = 300 queries/tick → 50 queries.
  const { data: rows } = await supabase
    .from("bulk_message_recipients")
    .select("status")
    .eq("job_id", jobId);

  const counts: Record<string, number> = {
    pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0,
  };
  for (const row of (rows || []) as Array<{ status: string }>) {
    if (counts[row.status] !== undefined) counts[row.status]++;
  }
  const total =
    counts.pending + counts.sending + counts.sent +
    counts.failed + counts.skipped + counts.cancelled;
  const allDone = counts.pending === 0 && counts.sending === 0;

  const update: Record<string, unknown> = {
    sent_count: counts.sent,
    failed_count: counts.failed,
    skipped_count: counts.skipped,
    total_contacts: total,
    updated_at: new Date().toISOString(),
  };
  let completed = false;
  if (allDone) {
    update.status = "completed";
    update.completed_at = new Date().toISOString();
    completed = true;
  }
  await supabase
    .from("bulk_message_jobs")
    .update(update)
    .eq("id", jobId)
    .eq("status", "running"); // só marca completed se ainda estava running
  return completed;
}
