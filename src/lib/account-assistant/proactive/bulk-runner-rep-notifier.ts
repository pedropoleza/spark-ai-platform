/**
 * Rep notifier quando bulk runner trava (Pedro 2026-05-16).
 *
 * Caso Gustavo: 3 jobs running com 0 sent por 21h, sem ninguém perceber.
 * Antes desta feature, só admin signals — rep ficava no escuro.
 *
 * Agora: quando bulk-runner-health-check detecta jobs stalled, esta função
 * envia mensagem WhatsApp pro(s) rep(s) afetado(s) avisando + diz que admin
 * já foi notificado.
 *
 * Dedup: 1 notif por rep a cada 30min (campo
 * rep_identities.profile.bulk_stall_notified_at). Evita spam se runner
 * tá travado por horas.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { deliverProactiveMessage } from "./whatsapp-delivery";

/**
 * Notifica reps que têm jobs travados.
 * @param repsToNotify Map<location_id, { reps: Set<rep_id>, jobs: Map<rep_id, job_labels[]> }>
 * @returns número de reps notificados
 */
export async function notifyRepsAboutStalledJobs(
  repsToNotify: Map<string, { reps: Set<string>; jobs: Map<string, string[]> }>,
): Promise<number> {
  const supabase = createAdminClient();
  let notified = 0;
  const COOLDOWN_MS = 30 * 60 * 1000; // 30min entre notifs por rep

  for (const [locationId, bucket] of repsToNotify) {
    for (const repId of bucket.reps) {
      try {
        // Carrega rep + checa última notif
        const { data: repRow } = await supabase
          .from("rep_identities")
          .select("id, phone, profile, last_inbound_at")
          .eq("id", repId)
          .maybeSingle();
        if (!repRow) continue;

        // C1 fix (review 2026-05-16): NÃO usar cast Pick que esconde outras
        // keys do JSONB. profile pode ter preferences.verbosity, aliases, etc.
        // Trabalhamos com profile cru pra merge defensivo no update abaixo.
        const profileFull = (repRow.profile || {}) as Record<string, unknown>;
        const lastNotif =
          typeof profileFull.bulk_stall_notified_at === "string"
            ? new Date(profileFull.bulk_stall_notified_at).getTime()
            : 0;
        if (Date.now() - lastNotif < COOLDOWN_MS) {
          // Dedup — já avisamos esse rep faz <30min
          continue;
        }

        const labels = bucket.jobs.get(repId) || [];
        const text =
          `⚠️ *Aviso do SparkBot:* Detectei que ${labels.length} disparo(s) seu(s) ` +
          `parece(m) travado(s):\n` +
          labels.slice(0, 5).map((l) => `  • ${l}`).join("\n") +
          (labels.length > 5 ? `\n  • ... +${labels.length - 5} mais` : "") +
          `\n\nO admin já foi notificado. ` +
          `Pode mandar "meus disparos" pra ver status atualizado, ou "pausa todos" se preferir parar enquanto investigamos.`;

        const result = await deliverProactiveMessage(
          { id: repRow.id, phone: repRow.phone, last_inbound_at: repRow.last_inbound_at },
          text,
          {
            activeLocationId: locationId,
            source: "bulk_runner_stall_alert",
            kind: "bulk_runner_stall",
            extraMetadata: {
              stalled_job_count: labels.length,
              location_id: locationId,
            },
          },
        );

        if (result.ok) {
          notified++;
          // C1 fix (review 2026-05-16): merge sobre profile COMPLETO pra
          // preservar preferences.verbosity, aliases, e qualquer outra key
          // que outros módulos possam ter adicionado.
          await supabase
            .from("rep_identities")
            .update({
              profile: {
                ...profileFull,
                bulk_stall_notified_at: new Date().toISOString(),
              },
            })
            .eq("id", repRow.id);
        }
      } catch (err) {
        console.warn(`[bulk-rep-notify] falhou pra rep ${repId}:`, err);
      }
    }
  }

  return notified;
}
