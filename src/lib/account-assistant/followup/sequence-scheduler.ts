/**
 * Persiste sequence + messages no DB (Pedro 2026-05-18).
 *
 * - Cria 1 row em followup_sequences
 * - Cria N rows em followup_messages (1 por draft)
 * - Cria 1 row em followup_events (event_type='created')
 * - Update counter denormalizado da sequence
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { GeneratedSequence, SpamScoreResult, ConversationSummary, FollowupInput, ApprovalStatus, SequenceStatus } from "./types";

interface PersistInput {
  followup_input: FollowupInput;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  conversation_id: string | null;
  sequence: GeneratedSequence;
  spam_score: SpamScoreResult;
  conversation_summary: ConversationSummary | null;
  context_source: "manual_only" | "conversation_used" | "mixed" | "none";
  base_scheduled_at: Date;            // primeira msg
  approval_status: ApprovalStatus;
  initial_status: SequenceStatus;     // 'draft' (pending_approval) ou 'scheduled' (auto-approved)
}

export interface PersistedSequence {
  sequence_id: string;
  message_ids: string[];
  scheduled_first_at: Date;
  scheduled_last_at: Date;
}

export async function persistSequence(input: PersistInput): Promise<PersistedSequence> {
  const supabase = createAdminClient();

  const messages = input.sequence.messages.slice().sort((a, b) => a.position - b.position);
  const firstAt = input.base_scheduled_at;
  const lastAt = new Date(
    firstAt.getTime() + (messages[messages.length - 1]?.offset_hours_from_first ?? 0) * 3600 * 1000,
  );

  // 1. Insert sequence
  const fi = input.followup_input;
  const { data: seq, error: seqErr } = await supabase
    .from("followup_sequences")
    .insert({
      rep_id: fi.rep_id,
      location_id: fi.location_id,
      agent_id: fi.agent_id,
      contact_id: input.contact_id,
      contact_name: input.contact_name,
      contact_phone: input.contact_phone,
      conversation_id: input.conversation_id,
      source: fi.source,
      source_metadata: fi.source_metadata ?? null,
      goal: fi.goal || input.sequence.inferred_goal || null,
      sequence_type: fi.sequence_type || "sales",
      tone: fi.tone || input.sequence.inferred_tone || null,
      context_source: input.context_source,
      context_summary: input.conversation_summary?.summary ?? null,
      spam_score: input.spam_score.score,
      spam_risk: input.spam_score.risk,
      spam_flags: input.spam_score.flags,
      spam_recommendation: input.spam_score.recommendation,
      approval_status: input.approval_status,
      approved_at:
        input.approval_status === "auto_approved" || input.approval_status === "approved"
          ? new Date().toISOString()
          : null,
      approved_by_rep: input.approval_status === "approved",
      status: input.initial_status,
      stop_on_reply: true,
      delivery_channel: fi.delivery_channel || "whatsapp_web_sms",
      total_messages: messages.length,
      scheduled_first_at: firstAt.toISOString(),
      scheduled_last_at: lastAt.toISOString(),
      started_at: input.initial_status === "scheduled" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (seqErr || !seq) {
    throw new Error(`persist sequence falhou: ${seqErr?.message}`);
  }

  const sequenceId = seq.id as string;

  // 2. Insert messages
  const messageIds: string[] = [];
  if (messages.length > 0) {
    const rows = messages.map((m) => {
      const scheduledAt = new Date(firstAt.getTime() + m.offset_hours_from_first * 3600 * 1000);
      return {
        sequence_id: sequenceId,
        position: m.position,
        message_text: m.text,
        message_text_original: m.text,
        tone_hint: m.tone_hint || null,
        scheduled_at: scheduledAt.toISOString(),
        status: input.initial_status === "scheduled" ? "pending" : "pending",
        // mesmo no draft, status=pending — quem decide se runner pega é a checagem
        // de sequence.status='running' antes de claim.
        requires_final_check: true,
      };
    });
    const { data: inserted, error: msgErr } = await supabase
      .from("followup_messages")
      .insert(rows)
      .select("id");

    if (msgErr || !inserted) {
      throw new Error(`persist messages falhou: ${msgErr?.message}`);
    }
    for (const r of inserted) {
      messageIds.push(r.id as string);
    }
  }

  // 3. Event log
  await supabase.from("followup_events").insert({
    sequence_id: sequenceId,
    event_type: input.approval_status === "auto_approved" ? "auto_approved" : "created",
    event_data: {
      source: fi.source,
      spam_risk: input.spam_score.risk,
      spam_score: input.spam_score.score,
      messages_count: messages.length,
      flags: input.spam_score.flags,
    },
  });

  return {
    sequence_id: sequenceId,
    message_ids: messageIds,
    scheduled_first_at: firstAt,
    scheduled_last_at: lastAt,
  };
}

/**
 * Parser flexível de "requested_at" — aceita ISO ou texto natural simples.
 * Pra MVP suporta:
 *   - ISO 8601 ("2026-05-20T10:00:00-04:00")
 *   - "today HH:MM" / "tomorrow HH:MM"
 *   - "in N days" / "in N hours"
 *   - Senão usa default: agora + default_interval_hours
 *
 * Casos mais complexos (sexta 9h, semana que vem) o LLM já interpretou e
 * passou ISO via tool args.
 */
export function parseRequestedAt(
  requested: string | undefined,
  defaultIntervalHours: number,
): Date {
  const now = Date.now();
  if (!requested) {
    return new Date(now + defaultIntervalHours * 3600 * 1000);
  }

  // Tenta ISO direto
  const iso = new Date(requested);
  if (!isNaN(iso.getTime()) && iso.getTime() > now - 60_000) {
    return iso;
  }

  // Texto natural simples
  const lower = requested.toLowerCase().trim();

  // Procura hora EXPLÍCITA — formato HH:MM ou Hh ou HHam/pm.
  // NÃO captura dígitos soltos pra evitar pegar "3" de "in 3 days".
  const explicitHourMatch = lower.match(/\b(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*h\b|\b(\d{1,2})\s*(am|pm)\b/i);
  const defaultHour = 10;
  const defaultMinute = 0;
  let hour = defaultHour;
  let minute = defaultMinute;
  if (explicitHourMatch) {
    if (explicitHourMatch[1]) {
      hour = parseInt(explicitHourMatch[1]);
      minute = parseInt(explicitHourMatch[2]);
    } else if (explicitHourMatch[3]) {
      hour = parseInt(explicitHourMatch[3]);
    } else if (explicitHourMatch[4]) {
      hour = parseInt(explicitHourMatch[4]);
      if (explicitHourMatch[5]?.toLowerCase() === "pm" && hour < 12) hour += 12;
      if (explicitHourMatch[5]?.toLowerCase() === "am" && hour === 12) hour = 0;
    }
  }

  if (lower.startsWith("today") || lower.includes("hoje")) {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now) d.setTime(now + 30 * 60 * 1000); // se hora passou, +30min
    return d;
  }
  if (lower.startsWith("tomorrow") || lower.includes("amanha") || lower.includes("amanhã")) {
    const d = new Date(now + 24 * 3600 * 1000);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  const daysMatch = lower.match(/in\s+(\d+)\s+days?|daqui\s+(\d+)\s+dias?/);
  if (daysMatch) {
    const n = parseInt(daysMatch[1] || daysMatch[2]);
    const d = new Date(now + n * 24 * 3600 * 1000);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  const hoursMatch = lower.match(/in\s+(\d+)\s+hours?|daqui\s+(\d+)\s+horas?/);
  if (hoursMatch) {
    const n = parseInt(hoursMatch[1] || hoursMatch[2]);
    return new Date(now + n * 3600 * 1000);
  }

  // Fallback default
  return new Date(now + defaultIntervalHours * 3600 * 1000);
}
