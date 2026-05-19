/**
 * Sequence monitor — pause/skip sequence quando contato responde
 * (Pedro 2026-05-18).
 *
 * Chamado pelo webhook-handler.ts ASSIM QUE detecta inbound. Mais rápido
 * que esperar o followup-runner descobrir no próximo tick.
 *
 * Strategy:
 *   1. Busca sequences ativas (scheduled/running) com contact_id == X
 *      E stop_on_reply=true
 *   2. Marca status=skipped_reply, cancelled_at=now, reason='contact_replied'
 *   3. Cancela msgs pending
 *   4. Insere event
 *   5. Cria sparkbot system msg (pro bot entender que pausou)
 *   6. Notifica rep proativamente via Stevo
 *
 * Idempotente: roda 2x não duplica.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface MonitorResult {
  paused_sequences: number;
  cancelled_messages: number;
  sequence_ids: string[];
}

export async function onContactInboundReceived(
  contactId: string,
  locationId: string,
): Promise<MonitorResult> {
  const result: MonitorResult = {
    paused_sequences: 0,
    cancelled_messages: 0,
    sequence_ids: [],
  };

  const supabase = createAdminClient();

  // Busca sequences elegíveis pra pause
  const { data: sequences } = await supabase
    .from("followup_sequences")
    .select("id, rep_id, agent_id, contact_name, sequence_type, goal, total_messages, sent_messages")
    .eq("contact_id", contactId)
    .eq("location_id", locationId)
    .eq("stop_on_reply", true)
    .in("status", ["scheduled", "running"]);

  if (!sequences || sequences.length === 0) return result;

  const now = new Date().toISOString();
  for (const seq of sequences) {
    // Mark sequence skipped_reply
    const { data: updated } = await supabase
      .from("followup_sequences")
      .update({
        status: "skipped_reply",
        cancelled_at: now,
        cancelled_reason: "contact_replied",
      })
      .eq("id", seq.id)
      .in("status", ["scheduled", "running"])
      .select("id");

    if (!updated || updated.length === 0) continue; // race com runner — já foi

    result.paused_sequences++;
    result.sequence_ids.push(seq.id);

    // Cancel pending msgs
    const { data: cancelledRows } = await supabase
      .from("followup_messages")
      .update({ status: "skipped", error_message: "contact_replied" })
      .eq("sequence_id", seq.id)
      .eq("status", "pending")
      .select("id");
    result.cancelled_messages += cancelledRows?.length ?? 0;

    // Audit event
    await supabase.from("followup_events").insert({
      sequence_id: seq.id,
      event_type: "contact_replied",
      event_data: { contact_id: contactId },
    });

    // Sistema msg pro bot saber (próxima call do rep vê isso no histórico)
    try {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id, location_id")
        .eq("id", seq.agent_id)
        .maybeSingle();
      if (agentRow) {
        await supabase.from("sparkbot_messages").insert({
          rep_id: seq.rep_id,
          hub_location_id: agentRow.location_id,
          agent_id: seq.agent_id,
          active_location_id: locationId,
          role: "agent",
          content:
            `[NOTA INTERNA] Follow-up sequence ${seq.id.slice(0, 8)} com ${seq.contact_name || contactId} foi PAUSADA porque o contato respondeu. ` +
            `Msgs futuras dessa sequence NÃO vão sair. Se rep perguntar status, use get_followup_progress.`,
          channel: "system",
          metadata: {
            source: "followup_sequence_paused_by_reply",
            sequence_id: seq.id,
            contact_id: contactId,
          },
        });
      }
    } catch (err) {
      console.warn(
        "[followup-monitor] system msg insert falhou:",
        err instanceof Error ? err.message.slice(0, 150) : err,
      );
    }

    // Notif proativa pro rep
    try {
      const { notifySequencePausedByReply } = await import("../proactive/followup-completion-notifier");
      await notifySequencePausedByReply(seq.id);
    } catch (err) {
      console.warn(
        `[followup-monitor] proactive notify falhou seq=${seq.id}:`,
        err instanceof Error ? err.message.slice(0, 150) : err,
      );
    }
  }

  return result;
}
