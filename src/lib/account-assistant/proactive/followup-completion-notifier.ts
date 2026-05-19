/**
 * Notifier de events de follow-up sequence (Pedro 2026-05-18).
 *
 * Templates:
 *   - notifySequenceAutoScheduled — risk low + adaptive/auto, sem aprovação
 *   - notifySequencePausedByReply — contato respondeu, sequence pausada
 *   - notifySequenceCompleted — todas msgs saíram (sent/failed/skipped)
 *   - notifySequenceBlockedByRecheck — runner detectou risk subiu (v2)
 *   - notifyInternalReminderFired — lembrete interno (v2)
 *
 * Reusa deliverProactiveMessage (Stevo). Dedup via rep.profile.followup_notified_*.
 * Skipa is_internal=true (admins não recebem spam de testes).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { deliverProactiveMessage } from "./whatsapp-delivery";

interface NotifyOutcome {
  notified: boolean;
  skipped_reason?: string;
}

/**
 * Notif: sequence completou (todas msgs saíram).
 */
export async function notifySequenceCompleted(sequenceId: string): Promise<NotifyOutcome> {
  const supabase = createAdminClient();
  try {
    const { data: seq } = await supabase
      .from("followup_sequences")
      .select(
        "id, rep_id, location_id, contact_name, contact_id, goal, total_messages, sent_messages, failed_messages, skipped_messages, started_at, completed_at",
      )
      .eq("id", sequenceId)
      .maybeSingle();
    if (!seq) return { notified: false, skipped_reason: "not_found" };

    const { data: rep } = await supabase
      .from("rep_identities")
      .select("id, phone, is_internal, profile, last_inbound_at")
      .eq("id", seq.rep_id)
      .maybeSingle();
    if (!rep) return { notified: false, skipped_reason: "rep_not_found" };
    if (rep.is_internal) return { notified: false, skipped_reason: "rep_internal" };

    const profile = (rep.profile || {}) as Record<string, unknown>;
    const notifiedSeqs = Array.isArray(profile.followup_completed_notified)
      ? (profile.followup_completed_notified as string[])
      : [];
    if (notifiedSeqs.includes(sequenceId)) {
      return { notified: false, skipped_reason: "already_notified" };
    }

    const text = formatCompletedMessage(seq);
    const result = await deliverProactiveMessage(
      { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
      text,
      {
        activeLocationId: seq.location_id,
        source: "followup_sequence_completed",
        kind: "followup_completed",
        extraMetadata: { sequence_id: sequenceId },
      },
    );
    if (!result.ok) return { notified: false, skipped_reason: "delivery_failed" };

    await supabase
      .from("rep_identities")
      .update({
        profile: {
          ...profile,
          followup_completed_notified: [...notifiedSeqs, sequenceId].slice(-100),
        },
      })
      .eq("id", rep.id);
    return { notified: true };
  } catch (err) {
    console.warn(
      "[followup-notifier:completed] erro:",
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return { notified: false, skipped_reason: "exception" };
  }
}

/**
 * Notif: contato respondeu, sequence pausada.
 */
export async function notifySequencePausedByReply(sequenceId: string): Promise<NotifyOutcome> {
  const supabase = createAdminClient();
  try {
    const { data: seq } = await supabase
      .from("followup_sequences")
      .select(
        "id, rep_id, location_id, contact_name, contact_id, sent_messages, total_messages, sequence_type",
      )
      .eq("id", sequenceId)
      .maybeSingle();
    if (!seq) return { notified: false, skipped_reason: "not_found" };

    const { data: rep } = await supabase
      .from("rep_identities")
      .select("id, phone, is_internal, profile, last_inbound_at")
      .eq("id", seq.rep_id)
      .maybeSingle();
    if (!rep) return { notified: false, skipped_reason: "rep_not_found" };
    if (rep.is_internal) return { notified: false, skipped_reason: "rep_internal" };

    const profile = (rep.profile || {}) as Record<string, unknown>;
    const notifiedSeqs = Array.isArray(profile.followup_paused_notified)
      ? (profile.followup_paused_notified as string[])
      : [];
    if (notifiedSeqs.includes(sequenceId)) {
      return { notified: false, skipped_reason: "already_notified" };
    }

    const contactName = seq.contact_name || seq.contact_id;
    const remaining = (seq.total_messages ?? 0) - (seq.sent_messages ?? 0);
    const text =
      `📩 *${contactName} respondeu!* Pausei o follow-up automaticamente.\n\n` +
      `Já enviei: ${seq.sent_messages}/${seq.total_messages}` +
      (remaining > 0 ? `\nFaltavam: ${remaining} msg(s)` : "") +
      `\n\nQuer que eu te ajude a responder?`;

    const result = await deliverProactiveMessage(
      { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
      text,
      {
        activeLocationId: seq.location_id,
        source: "followup_sequence_paused_by_reply",
        kind: "followup_paused",
        extraMetadata: { sequence_id: sequenceId, contact_id: seq.contact_id },
      },
    );
    if (!result.ok) return { notified: false, skipped_reason: "delivery_failed" };

    await supabase
      .from("rep_identities")
      .update({
        profile: {
          ...profile,
          followup_paused_notified: [...notifiedSeqs, sequenceId].slice(-100),
        },
      })
      .eq("id", rep.id);
    return { notified: true };
  } catch (err) {
    console.warn(
      "[followup-notifier:paused] erro:",
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return { notified: false, skipped_reason: "exception" };
  }
}

function formatCompletedMessage(seq: {
  contact_name: string | null;
  contact_id: string;
  total_messages: number;
  sent_messages: number;
  failed_messages: number;
  skipped_messages: number;
  started_at: string | null;
  completed_at: string | null;
  goal: string | null;
}): string {
  const contactName = seq.contact_name || seq.contact_id;
  const sent = seq.sent_messages ?? 0;
  const total = seq.total_messages ?? 0;
  const failed = seq.failed_messages ?? 0;
  const failurePct = total > 0 ? (failed / total) * 100 : 0;

  const durationStr = (() => {
    if (!seq.started_at || !seq.completed_at) return null;
    const dur = new Date(seq.completed_at).getTime() - new Date(seq.started_at).getTime();
    const mins = Math.round(dur / 60000);
    if (mins < 60) return `${mins}min`;
    const h = Math.floor(mins / 60);
    return mins % 60 > 0 ? `${h}h${mins % 60}min` : `${h}h`;
  })();

  if (failurePct > 50) {
    return (
      `⚠️ *Follow-up com ${contactName} terminou COM FALHAS*\n\n` +
      `📊 ${sent}/${total} enviados (${failed} falhas)\n` +
      (durationStr ? `⏱ Duração: ${durationStr}\n` : "") +
      `\n"get_followup_progress" pra ver detalhe das falhas.`
    );
  }

  return (
    `✅ *Follow-up com ${contactName} finalizado!*\n\n` +
    `📊 ${sent}/${total} enviados` +
    (failed > 0 ? ` (${failed} falhas)` : "") +
    `\n` +
    (durationStr ? `⏱ Duração: ${durationStr}\n` : "") +
    `\nSem resposta ainda — pode tentar outro canal ou esperar.\n` +
    `💡 "meus follow-ups" — lista ativos`
  );
}
