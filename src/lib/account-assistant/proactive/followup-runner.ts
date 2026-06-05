/**
 * Follow-up Runner (Pedro 2026-05-18).
 *
 * Cron Vercel periódico claim+executa followup_messages com:
 *   - status='pending' AND scheduled_at <= now()
 *   - sequence.status='running' (não draft/paused/cancelled)
 *
 * Pra cada msg claimed:
 *   1. Re-check sequence.status==='running' (race com pause/cancel)
 *   2. Detect inbound do contato após sequence.started_at → marca skipped
 *   3. Se requires_final_check: recalcula spam_score; se virou high → skip
 *   4. Envia via GHL /conversations/messages (mesma function do bulk)
 *   5. Update status sent + sent_at + ghl_message_id
 *   6. Se foi a última msg da sequence: marca sequence.status='completed' +
 *      dispara sequence-notifier
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";
import { GHLClient } from "@/lib/ghl/client";

const MAX_PER_TICK = 30;
const STARTUP_GRACE_SECONDS = 5;

export interface RunnerTickResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  completed_sequences: number;
}

export async function runFollowupTick(): Promise<RunnerTickResult> {
  const supabase = createAdminClient();
  const result: RunnerTickResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    completed_sequences: 0,
  };

  const nowIso = new Date().toISOString();
  const claimToken = crypto.randomUUID();

  // 1. Claim atomic — só pega msgs cuja sequence está em 'scheduled' ou 'running'
  //    (drafts não saem; paused/cancelled também não)
  const { data: candidates } = await supabase
    .from("followup_messages")
    .select(
      "id, sequence_id, position, message_text, scheduled_at, status, requires_final_check, followup_sequences!inner(status, contact_id, contact_phone, location_id, rep_id, agent_id, delivery_channel, stop_on_reply, started_at)",
    )
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(MAX_PER_TICK * 2);

  if (!candidates || candidates.length === 0) return result;

  // Filtra client-side por status running/scheduled
  interface SeqInfo {
    status: string;
    contact_id: string;
    contact_phone: string | null;
    location_id: string;
    rep_id: string;
    agent_id: string | null;
    delivery_channel: string;
    stop_on_reply: boolean;
    started_at: string | null;
  }
  interface Candidate {
    id: string;
    sequence_id: string;
    position: number;
    message_text: string;
    scheduled_at: string;
    status: string;
    requires_final_check: boolean;
    seq: SeqInfo;
  }

  const eligible: Candidate[] = [];
  for (const raw of candidates as Array<Record<string, unknown>>) {
    const seqField = raw.followup_sequences;
    const seq: SeqInfo | null = Array.isArray(seqField)
      ? ((seqField[0] as SeqInfo | undefined) ?? null)
      : ((seqField as SeqInfo | null) ?? null);
    if (!seq || !["scheduled", "running"].includes(seq.status)) continue;
    eligible.push({
      id: raw.id as string,
      sequence_id: raw.sequence_id as string,
      position: raw.position as number,
      message_text: raw.message_text as string,
      scheduled_at: raw.scheduled_at as string,
      status: raw.status as string,
      requires_final_check: (raw.requires_final_check as boolean | null) ?? true,
      seq,
    });
    if (eligible.length >= MAX_PER_TICK) break;
  }

  if (eligible.length === 0) return result;

  // Claim atomico via update com filter status=pending
  const ids = eligible.map((c) => c.id);
  const { data: claimed } = await supabase
    .from("followup_messages")
    .update({
      status: "sending",
      claim_token: claimToken,
      claimed_at: nowIso,
    })
    .in("id", ids)
    .eq("status", "pending")
    .select("id");

  if (!claimed || claimed.length === 0) return result;
  const claimedIds = new Set(claimed.map((c) => c.id as string));
  result.claimed = claimedIds.size;

  // Process each
  const sequencesTouched = new Set<string>();
  for (const cand of eligible) {
    if (!claimedIds.has(cand.id)) continue;
    const seqInfo = cand.seq;
    sequencesTouched.add(cand.sequence_id);

    try {
      // Re-check sequence status (paused/cancelled durante tick)
      const { data: seqNow } = await supabase
        .from("followup_sequences")
        .select("status, started_at")
        .eq("id", cand.sequence_id)
        .maybeSingle();
      if (!seqNow || !["scheduled", "running"].includes(seqNow.status)) {
        await supabase
          .from("followup_messages")
          .update({ status: "skipped", error_message: `sequence_status_${seqNow?.status || "unknown"}` })
          .eq("id", cand.id);
        result.skipped++;
        continue;
      }

      // Detect inbound desde started_at se stop_on_reply
      if (seqInfo.stop_on_reply && seqInfo.started_at) {
        const replied = await contactRepliedAfter(
          seqInfo.contact_id,
          seqInfo.location_id,
          seqInfo.started_at,
        );
        if (replied) {
          // Pausa sequence e marca essa msg skipped
          await markSequenceSkippedReply(cand.sequence_id);
          await supabase
            .from("followup_messages")
            .update({ status: "skipped", error_message: "contact_replied" })
            .eq("id", cand.id);
          result.skipped++;
          continue;
        }
      }

      // Transition scheduled→running na primeira msg que envia
      if (seqNow.status === "scheduled") {
        await supabase
          .from("followup_sequences")
          .update({ status: "running" })
          .eq("id", cand.sequence_id)
          .eq("status", "scheduled");
      }

      // Recheck spam_score se requires_final_check (TODO MVP v2 — pra MVP skip)
      // ...

      // Envia
      const sendResult = await sendFollowupMessage({
        location_id: seqInfo.location_id,
        contact_id: seqInfo.contact_id,
        delivery_channel: seqInfo.delivery_channel,
        message: cand.message_text,
      });

      if (sendResult.ok) {
        await supabase
          .from("followup_messages")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            ghl_message_id: sendResult.message_id || null,
          })
          .eq("id", cand.id);
        await supabase.from("followup_events").insert({
          sequence_id: cand.sequence_id,
          event_type: "message_sent",
          event_data: {
            position: cand.position,
            ghl_message_id: sendResult.message_id || null,
          },
        });
        result.sent++;
      } else {
        await supabase
          .from("followup_messages")
          .update({
            status: "failed",
            error_message: sendResult.error?.slice(0, 500) || "send_failed",
          })
          .eq("id", cand.id);
        await supabase.from("followup_events").insert({
          sequence_id: cand.sequence_id,
          event_type: "message_failed",
          event_data: { position: cand.position, error: sendResult.error?.slice(0, 200) },
        });
        result.failed++;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message.slice(0, 500) : String(err);
      console.error(`[followup-runner] msg ${cand.id} fail:`, m);
      // Sweep F49 2026-06-05: msg de follow-up crashou → lead não recebe.
      reportError({ title: "Followup runner: msg de follow-up falhou", feature: "proactive-followup", severity: "medium", error: err, metadata: { messageId: cand.id } });
      await supabase
        .from("followup_messages")
        .update({ status: "failed", error_message: m })
        .eq("id", cand.id);
      result.failed++;
    }
  }

  // Refresh counters + check completion
  for (const seqId of sequencesTouched) {
    const completed = await refreshSequenceCounters(seqId);
    if (completed) {
      result.completed_sequences++;
      try {
        const { notifySequenceCompleted } = await import("./followup-completion-notifier");
        await notifySequenceCompleted(seqId);
      } catch (err) {
        console.warn(
          `[followup-runner] completion notify falhou seq=${seqId}:`,
          err instanceof Error ? err.message.slice(0, 200) : err,
        );
      }
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

interface SendInput {
  location_id: string;
  contact_id: string;
  delivery_channel: string;
  message: string;
}

async function sendFollowupMessage(input: SendInput): Promise<{
  ok: boolean;
  message_id?: string;
  error?: string;
}> {
  try {
    const supabase = createAdminClient();
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", input.location_id)
      .maybeSingle();
    if (!location) return { ok: false, error: "location não sincronizada" };

    const client = new GHLClient(location.company_id, input.location_id);
    const ghlType = input.delivery_channel === "whatsapp_api" ? "WhatsApp" : "SMS";

    const trySend = async (ch: string) =>
      client.post<{ messageId?: string }>("/conversations/messages", {
        type: ch,
        contactId: input.contact_id,
        message: input.message,
      });

    try {
      const r = await trySend(ghlType);
      return { ok: true, message_id: r.messageId };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (
        ghlType === "WhatsApp" &&
        /no active whatsapp subscription|whatsapp.*not.*active|whatsapp.*disabled/i.test(m)
      ) {
        const r = await trySend("SMS");
        return { ok: true, message_id: r.messageId };
      }
      return { ok: false, error: m };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Detecta se contato respondeu após T0.
 * Procura inbound em GHL conversations + sparkbot_messages.
 */
async function contactRepliedAfter(
  contactId: string,
  locationId: string,
  afterIso: string,
): Promise<boolean> {
  try {
    const supabase = createAdminClient();
    const { data: loc } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", locationId)
      .maybeSingle();
    if (!loc?.company_id) return false;

    const client = new GHLClient(loc.company_id, locationId);
    const convs = await client.get<{
      conversations?: Array<{ id: string }>;
    }>("/conversations/search", { locationId, contactId });

    const afterTs = new Date(afterIso).getTime();
    for (const conv of convs.conversations || []) {
      try {
        const msgs = await client.get<{
          messages?: { messages?: Array<{ direction: string; dateAdded: string }> };
        }>(`/conversations/${conv.id}/messages`, { locationId, limit: "10" });
        const inbound = (msgs.messages?.messages || []).find(
          (m) =>
            m.direction === "inbound" && new Date(m.dateAdded).getTime() > afterTs + STARTUP_GRACE_SECONDS * 1000,
        );
        if (inbound) return true;
      } catch {
        // ignore
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function markSequenceSkippedReply(sequenceId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("followup_sequences")
    .update({
      status: "skipped_reply",
      cancelled_at: new Date().toISOString(),
      cancelled_reason: "contact_replied",
    })
    .eq("id", sequenceId)
    .in("status", ["scheduled", "running"]);

  // Cancela msgs pending
  await supabase
    .from("followup_messages")
    .update({ status: "skipped", error_message: "contact_replied" })
    .eq("sequence_id", sequenceId)
    .eq("status", "pending");

  await supabase.from("followup_events").insert({
    sequence_id: sequenceId,
    event_type: "contact_replied",
    event_data: {},
  });

  // Notif proativa
  try {
    const { notifySequencePausedByReply } = await import("./followup-completion-notifier");
    await notifySequencePausedByReply(sequenceId);
  } catch (err) {
    console.warn(
      `[followup-runner] paused notify falhou seq=${sequenceId}:`,
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
  }
}

/**
 * Recalcula counters da sequence + marca completed se todos terminal.
 * Retorna true se acabou de virar completed nessa call.
 */
async function refreshSequenceCounters(sequenceId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data: msgs } = await supabase
    .from("followup_messages")
    .select("status")
    .eq("sequence_id", sequenceId);
  if (!msgs) return false;

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let pending = 0;
  for (const m of msgs) {
    if (m.status === "sent") sent++;
    else if (m.status === "failed") failed++;
    else if (m.status === "skipped" || m.status === "cancelled") skipped++;
    else pending++;
  }

  const allDone = pending === 0;
  const update: Record<string, unknown> = {
    sent_messages: sent,
    failed_messages: failed,
    skipped_messages: skipped,
    updated_at: new Date().toISOString(),
  };
  if (allDone) {
    update.status = "completed";
    update.completed_at = new Date().toISOString();
  }

  const { data: updated } = await supabase
    .from("followup_sequences")
    .update(update)
    .eq("id", sequenceId)
    .in("status", ["scheduled", "running"])
    .select("id");

  if (allDone && updated && updated.length > 0) {
    await supabase.from("followup_events").insert({
      sequence_id: sequenceId,
      event_type: "completed",
      event_data: { sent, failed, skipped },
    });
    return true;
  }
  return false;
}
