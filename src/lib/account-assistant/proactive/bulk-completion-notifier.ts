/**
 * Notifica rep quando bulk job termina (Pedro 2026-05-18).
 *
 * Chamado pelo runner em `refreshJobCounters` quando detecta transição
 * running → completed. Envia msg proativa pro rep via canal padrão
 * (Stevo/Evolution → WhatsApp).
 *
 * Cuidados:
 *   - Skipa se rep is_internal=true (admin não recebe spam de testes)
 *   - Skipa se job tem < MIN_RECIPIENTS_TO_NOTIFY (jobs micro-teste)
 *   - Skipa se job foi cancelado pelo rep (motivo já claro pra ele)
 *   - Tom muda conforme % de falhas (sucesso vs problema)
 *   - Idempotente: dedup via metadata.bulk_completion_notified_for_job
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { deliverProactiveMessage } from "./whatsapp-delivery";

const MIN_RECIPIENTS_TO_NOTIFY = 3;
const FAILURE_THRESHOLD_PCT = 10; // > 10% = tom de alerta

export interface NotifyResult {
  notified: boolean;
  skipped_reason?: string;
}

/**
 * Notifica rep que um job dele foi concluído.
 * No-op em qualquer condição de skip (logged).
 */
export async function notifyRepJobCompleted(jobId: string): Promise<NotifyResult> {
  const supabase = createAdminClient();

  try {
    // 1. Carrega job + rep
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select(
        "id, rep_id, location_id, label, filter_config, status, total_contacts, sent_count, failed_count, skipped_count, created_at, completed_at, start_at",
      )
      .eq("id", jobId)
      .maybeSingle();

    if (!job) {
      return { notified: false, skipped_reason: "job_not_found" };
    }

    // Só notifica se status=completed (não cancelled/failed/etc)
    if (job.status !== "completed") {
      return { notified: false, skipped_reason: `status_${job.status}` };
    }

    if (job.total_contacts < MIN_RECIPIENTS_TO_NOTIFY) {
      return { notified: false, skipped_reason: "below_min_recipients" };
    }

    // 2. Carrega rep + checa is_internal + dedup
    const { data: rep } = await supabase
      .from("rep_identities")
      .select("id, phone, is_internal, profile, last_inbound_at")
      .eq("id", job.rep_id)
      .maybeSingle();

    if (!rep) {
      return { notified: false, skipped_reason: "rep_not_found" };
    }
    if (rep.is_internal) {
      return { notified: false, skipped_reason: "rep_internal" };
    }

    // Dedup: se já notificamos esse job, skip
    const profile = (rep.profile || {}) as Record<string, unknown>;
    const notifiedJobs = Array.isArray(profile.bulk_completion_notified_jobs)
      ? (profile.bulk_completion_notified_jobs as string[])
      : [];
    if (notifiedJobs.includes(jobId)) {
      return { notified: false, skipped_reason: "already_notified" };
    }

    // 3. Compõe texto
    const text = formatCompletionMessage(job);

    // 4. Envia via canal padrão
    const result = await deliverProactiveMessage(
      { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
      text,
      {
        activeLocationId: job.location_id,
        source: "bulk_completion_notification",
        kind: "bulk_completed",
        extraMetadata: {
          job_id: jobId,
          sent: job.sent_count,
          failed: job.failed_count,
          total: job.total_contacts,
        },
      },
    );

    if (!result.ok) {
      console.warn(
        `[bulk-completion-notify] entrega falhou job=${jobId} rep=${rep.id}: ${result.error}`,
      );
      return { notified: false, skipped_reason: "delivery_failed" };
    }

    // 5. Marca dedup (append jobId, mantém último 50)
    const updatedJobs = [...notifiedJobs, jobId].slice(-50);
    await supabase
      .from("rep_identities")
      .update({
        profile: {
          ...profile,
          bulk_completion_notified_jobs: updatedJobs,
        },
      })
      .eq("id", rep.id);

    return { notified: true };
  } catch (err) {
    console.warn(
      `[bulk-completion-notify] erro job=${jobId}:`,
      err instanceof Error ? err.message : err,
    );
    return { notified: false, skipped_reason: "exception" };
  }
}

/**
 * Monta texto da notificação. Tom muda conforme % de falhas.
 */
function formatCompletionMessage(job: {
  label: string | null;
  filter_config: unknown;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  start_at: string | null;
  completed_at: string | null;
}): string {
  const total = job.total_contacts;
  const sent = job.sent_count ?? 0;
  const failed = job.failed_count ?? 0;
  const failurePct = total > 0 ? (failed / total) * 100 : 0;

  // Display name: label > segments > template_preview
  const fc = job.filter_config as { type?: string; segments?: Array<{ label: string }>; tag?: string } | null;
  const segments = fc?.type === "multi"
    ? (fc.segments || []).map((s) => s.label).join(", ")
    : fc?.tag || null;
  const displayName = job.label || segments || "Disparo";

  // Duração
  const durationStr = (() => {
    if (!job.start_at || !job.completed_at) return null;
    const startMs = new Date(job.start_at).getTime();
    const endMs = new Date(job.completed_at).getTime();
    const minutes = Math.round((endMs - startMs) / 60000);
    if (minutes < 1) return "<1min";
    if (minutes < 60) return `${minutes}min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h${m}min`;
  })();

  const hasIssues = failurePct > FAILURE_THRESHOLD_PCT;

  if (hasIssues) {
    const lines = [
      `⚠️ *Disparo "${displayName}" finalizado COM FALHAS*`,
      "",
      `📊 Resultado:`,
      `  • ${sent}/${total} enviados`,
      `  • *${failed} falhas (${Math.round(failurePct)}%)*`,
    ];
    if ((job.skipped_count ?? 0) > 0) lines.push(`  • ${job.skipped_count} skipados`);
    if (durationStr) lines.push(`  • Duração: ${durationStr}`);
    lines.push("");
    lines.push(
      `Recomendo conferir o motivo: "como tá o disparo" → mostra os contatos que falharam.`,
    );
    return lines.join("\n");
  }

  // Sucesso normal
  const lines = [
    `✅ *Disparo "${displayName}" finalizado!*`,
    "",
    `📊 Resultado:`,
    `  • ${sent}/${total} enviados`,
  ];
  if (failed > 0) lines.push(`  • ${failed} falhas`);
  if ((job.skipped_count ?? 0) > 0) lines.push(`  • ${job.skipped_count} skipados`);
  if (durationStr) lines.push(`  • Duração: ${durationStr}`);
  lines.push("");
  lines.push(`Próximo passo: monitora as respostas.`);
  lines.push(`💡 "meus disparos" — dashboard`);
  return lines.join("\n");
}
