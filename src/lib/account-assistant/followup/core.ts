/**
 * Core service do domínio follow-up (Pedro 2026-05-18).
 *
 * Entry point ÚNICO: createFollowupRequest(input).
 * Chamado por:
 *   - chat tool create_followup_request (MVP)
 *   - assistant_proactive_rules dispatcher (futuro post_meeting follow-up)
 *   - webhook handler de pipeline_stage_changed (futuro)
 *
 * Orquestra:
 *   1. resolveContact (id ou query) — disambiguation
 *   2. loadSettings (per-agent)
 *   3. resolveContext (busca conversa + summary)
 *   4. computeSpamScore (regras + LLM ambíguo)
 *   5. runSafetyChecks (opt-out, duplicate, wallet)
 *   6. generateSequence (LLM gera N msgs)
 *   7. decideFlow (auto/approval/block conforme settings × risk)
 *   8. persistSequence (DB)
 *   9. retorna FollowupResult estruturado pra tool/caller
 */

import type { GHLClient } from "@/lib/ghl/client";
import { GHLClient as GHLClientCtor } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  FollowupInput,
  FollowupResult,
  FollowupSettings,
  SpamRisk,
  ApprovalStatus,
  SequenceStatus,
} from "./types";
import { loadFollowupSettings } from "./settings-loader";
import { resolveConversationContext } from "./context-resolver";
import { summarizeConversation } from "./conversation-summarizer";
import { computeSpamScore } from "./spam-score";
import { runSafetyChecks } from "./safety-checks";
import { generateSequence } from "./sequence-generator";
import { persistSequence, parseRequestedAt } from "./sequence-scheduler";

/**
 * Entry point reutilizável.
 */
export async function createFollowupRequest(
  input: FollowupInput,
  ghlClient?: GHLClient,
): Promise<FollowupResult> {
  try {
    // 0. Resolve GHL client se não passado (webhook futuro vai precisar)
    let client = ghlClient;
    if (!client) {
      // companyId precisa ser resolvido — supabase locations table tem o mapping
      const supabase = createAdminClient();
      const { data: loc } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", input.location_id)
        .maybeSingle();
      if (!loc?.company_id) {
        return errorResult("internal", `Location ${input.location_id} sem company_id no DB`);
      }
      client = new GHLClientCtor(loc.company_id, input.location_id);
    }

    // 1. Carrega settings
    const settings = await loadFollowupSettings(input.agent_id);
    if (!settings.feature_enabled) {
      return errorResult("feature_disabled", "Feature follow-up desabilitada pra esse agent.");
    }

    // 2. Resolve contact
    const contact = await resolveContact(client, input);
    if (!contact.ok) return contact.result!;
    const { contact_id, contact_name, contact_phone, contact_tags, conversation_id } = contact.data!;

    // 3. Se rep não disse use_conversation_context E não passou manual_context → pede decisão
    const needsUserContextDecision =
      input.use_conversation_context === undefined &&
      !input.manual_context &&
      settings.allow_conversation_context &&
      input.source === "chat";

    let conversationSummary = null;
    let contextSource: "manual_only" | "conversation_used" | "mixed" | "none" = "none";

    if (needsUserContextDecision) {
      // Não bloqueia — segue com manual context vazio.
      // Caller (tool) pode escolher mostrar essa needs_user_decision PRIMEIRO.
      // Pra MVP: se source=chat, retorna early pedindo decisão.
      return {
        ok: false,
        needs_user_decision: {
          kind: "use_conversation_context",
          prompt: `Quer que eu use as últimas conversas com ${contact_name || "esse contato"} pra deixar o follow-up mais contextualizado?`,
          options: ["Usar conversa", "Vou explicar o contexto", "Mensagem genérica"],
        },
      };
    }

    if (input.use_conversation_context === true && settings.allow_conversation_context) {
      const signals = await resolveConversationContext(client, contact_id, input.location_id);
      conversationSummary = await summarizeConversation(signals, input.goal);
      contextSource = input.manual_context ? "mixed" : "conversation_used";
    } else if (input.manual_context) {
      contextSource = "manual_only";
    }

    // 4. Spam score (precisa de signals — busca de novo se não tem summary)
    const signals = conversationSummary
      ? await resolveConversationContext(client, contact_id, input.location_id, { limit: 20 })
      : await resolveConversationContext(client, contact_id, input.location_id, { limit: 20 });
    const isActiveClient = contact_tags.some((t) => /client|cliente|active|ativo/i.test(t));
    const existingSeqs = await countActiveSequences(contact_id, input.location_id);
    const spam = await computeSpamScore({
      signals,
      contact_tags,
      is_active_client: isActiveClient,
      has_recent_appointment: false, // MVP: não busca appointment ainda
      existing_active_sequences: existingSeqs,
      planned_sequence_length: input.sequence_length ?? settings.default_sequence_length,
    });

    // 5. Safety checks
    const safety = await runSafetyChecks({
      rep_id: input.rep_id,
      location_id: input.location_id,
      agent_id: input.agent_id,
      contact_id,
      contact_tags,
      delivery_channel: input.delivery_channel || "whatsapp_web_sms",
      settings,
    });
    if (!safety.ok && safety.block_reason) {
      const reason = safety.block_reason;
      return {
        ok: false,
        error: {
          kind:
            reason.kind === "feature_disabled"
              ? "feature_disabled"
              : reason.kind === "contact_opted_out"
                ? "opt_out"
                : reason.kind === "duplicate_active_sequence"
                  ? "duplicate_active_sequence"
                  : "wallet_blocked",
          message: reason.message,
        },
      };
    }

    // 6. Decide flow ANTES de gastar tokens caro com generator se risk=high
    const requestedSeqLen = input.sequence_length ?? settings.default_sequence_length;
    const effectiveSeqLen = Math.min(
      requestedSeqLen,
      spam.max_suggested_messages,
      settings.max_sequence_length,
    );
    const decision = decideFlow(spam.risk, settings.approval_mode);

    if (decision === "blocked_high_risk") {
      // Sugere internal reminder em vez de sequence externa
      return {
        ok: true,
        flow_decision: "blocked_high_risk",
        spam_score: spam.score,
        spam_risk: spam.risk,
        spam_flags: spam.flags,
        spam_recommendation:
          "Sequência externa bloqueada (risco alto). Sugiro `internal_reminder` — bot só te lembra pra você tentar outro canal.",
        ai_presentation_hint:
          `Conversa com ${contact_name || "esse contato"} parece fria (${spam.flags.join(", ")}). ` +
          `Não recomendo follow-up automático. Posso só criar um lembrete interno pra você tentar outro canal?`,
      };
    }

    // 7. Generate
    const generated = await generateSequence({
      contact_name,
      contact_first_name: contact_name ? contact_name.split(" ")[0] : null,
      goal: input.goal,
      manual_context: input.manual_context,
      conversation_summary: conversationSummary ?? undefined,
      spam_score: spam,
      desired_length: effectiveSeqLen,
      default_interval_hours: settings.default_interval_hours,
      tone_hint: input.tone,
      sequence_type: input.sequence_type || "sales",
    });

    if (generated.messages.length === 0) {
      return errorResult("internal", "Generator não produziu nenhuma mensagem.");
    }

    // 8. Persist
    const baseAt = parseRequestedAt(input.requested_at, settings.default_interval_hours);
    const approvalStatus: ApprovalStatus =
      decision === "auto_scheduled" ? "auto_approved" : "pending_approval";
    const initialStatus: SequenceStatus = decision === "auto_scheduled" ? "scheduled" : "draft";

    const persisted = await persistSequence({
      followup_input: input,
      contact_id,
      contact_name,
      contact_phone,
      conversation_id,
      sequence: generated,
      spam_score: spam,
      conversation_summary: conversationSummary,
      context_source: contextSource,
      base_scheduled_at: baseAt,
      approval_status: approvalStatus,
      initial_status: initialStatus,
    });

    // 9. Result
    const result: FollowupResult = {
      ok: true,
      sequence_id: persisted.sequence_id,
      flow_decision: decision === "auto_scheduled" ? "auto_scheduled" : "approval_required",
      spam_score: spam.score,
      spam_risk: spam.risk,
      spam_flags: spam.flags,
      spam_recommendation: spam.recommendation,
      messages_preview: generated.messages.map((m) => {
        const scheduledAt = new Date(baseAt.getTime() + m.offset_hours_from_first * 3600 * 1000);
        return {
          position: m.position,
          text: m.text,
          scheduled_at: scheduledAt.toISOString(),
          scheduled_at_human: scheduledAt.toLocaleString("pt-BR", {
            timeZone: "America/New_York",
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
        };
      }),
      ai_presentation_hint:
        decision === "auto_scheduled"
          ? `✅ Agendei follow-up pra ${contact_name || "contato"} (${generated.messages.length} msg, risco baixo).`
          : `Preparei sequência (risco ${spam.risk}). Confirma agendar?`,
    };

    return result;
  } catch (err) {
    return errorResult(
      "internal",
      err instanceof Error ? err.message.slice(0, 300) : String(err),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function errorResult(kind: NonNullable<FollowupResult["error"]>["kind"], message: string): FollowupResult {
  return { ok: false, error: { kind, message } };
}

type ContactResolution =
  | {
      ok: true;
      data: {
        contact_id: string;
        contact_name: string | null;
        contact_phone: string | null;
        contact_tags: string[];
        conversation_id: string | null;
      };
    }
  | { ok: false; result: FollowupResult };

async function resolveContact(
  client: GHLClient,
  input: FollowupInput,
): Promise<ContactResolution> {
  // Caminho rápido: já temos contact_id
  if (input.contact_id) {
    try {
      const resp = await client.get<{
        contact?: { id: string; firstName?: string; lastName?: string; phone?: string; tags?: string[] };
      }>(`/contacts/${input.contact_id}`);
      const c = resp.contact;
      if (!c) {
        return {
          ok: false,
          result: errorResult("contact_not_found", `Contact ${input.contact_id} não encontrado.`),
        };
      }
      return {
        ok: true,
        data: {
          contact_id: c.id,
          contact_name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || null,
          contact_phone: c.phone || null,
          contact_tags: c.tags || [],
          conversation_id: null,
        },
      };
    } catch {
      return {
        ok: false,
        result: errorResult("contact_not_found", `Falha ao ler contact ${input.contact_id}.`),
      };
    }
  }

  // Caminho lento: query
  if (!input.contact_query) {
    return {
      ok: false,
      result: errorResult("contact_not_found", "Sem contact_id nem contact_query."),
    };
  }

  try {
    const r = await client.post<{
      contacts?: Array<{ id: string; firstName?: string; lastName?: string; phone?: string; tags?: string[] }>;
    }>("/contacts/search", {
      locationId: input.location_id,
      query: input.contact_query,
      pageLimit: 5,
    });
    const contacts = r.contacts || [];
    if (contacts.length === 0) {
      return {
        ok: false,
        result: errorResult(
          "contact_not_found",
          `Não achei contato com "${input.contact_query}". Pode me passar phone ou nome completo?`,
        ),
      };
    }
    if (contacts.length > 1) {
      return {
        ok: false,
        result: {
          ok: false,
          error: {
            kind: "contact_ambiguous",
            message: `Achei ${contacts.length} contatos com "${input.contact_query}". Qual deles?`,
            candidates: contacts.slice(0, 5).map((c) => ({
              id: c.id,
              name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "(sem nome)",
              phone: c.phone,
            })),
          },
        },
      };
    }
    const c = contacts[0];
    return {
      ok: true,
      data: {
        contact_id: c.id,
        contact_name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || null,
        contact_phone: c.phone || null,
        contact_tags: c.tags || [],
        conversation_id: null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      result: errorResult(
        "internal",
        `search contact falhou: ${err instanceof Error ? err.message : err}`,
      ),
    };
  }
}

async function countActiveSequences(
  contact_id: string,
  location_id: string,
): Promise<number> {
  const supabase = createAdminClient();
  const { count } = await supabase
    .from("followup_sequences")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contact_id)
    .eq("location_id", location_id)
    .in("status", ["scheduled", "running", "paused"]);
  return count ?? 0;
}

/**
 * Decide flow conforme spam_risk × approval_mode.
 *
 *   low + adaptive → auto
 *   low + auto_low_risk → auto
 *   low + always_ask → approval
 *   low + auto_all → auto
 *
 *   medium + adaptive → approval
 *   medium + auto_low_risk → approval
 *   medium + always_ask → approval
 *   medium + auto_all → auto
 *
 *   high + adaptive → block (sugere internal)
 *   high + always_ask → approval (mostra warning)
 *   high + auto_low_risk → block
 *   high + auto_all → block (safety override)
 */
type FlowDecision = "auto_scheduled" | "approval_required" | "blocked_high_risk";
function decideFlow(risk: SpamRisk, mode: FollowupSettings["approval_mode"]): FlowDecision {
  if (risk === "high") {
    if (mode === "always_ask") return "approval_required";
    return "blocked_high_risk";
  }
  if (mode === "always_ask") return "approval_required";
  if (mode === "auto_all") return "auto_scheduled";
  if (mode === "auto_low_risk") return risk === "low" ? "auto_scheduled" : "approval_required";
  // adaptive (default)
  return risk === "low" ? "auto_scheduled" : "approval_required";
}

// ─────────────────────────────────────────────────────────────
// Approval mutators (chamados pelas tools approve/edit/cancel/pause/resume)
// ─────────────────────────────────────────────────────────────

export async function approveSequence(sequenceId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();
  const { data: seq } = await supabase
    .from("followup_sequences")
    .select("id, status, approval_status")
    .eq("id", sequenceId)
    .maybeSingle();
  if (!seq) return { ok: false, error: "sequence não encontrada" };
  if (seq.status !== "draft") return { ok: false, error: `sequence está '${seq.status}', só aprova drafts` };

  const now = new Date().toISOString();
  await supabase
    .from("followup_sequences")
    .update({
      approval_status: "approved",
      approved_at: now,
      approved_by_rep: true,
      status: "scheduled",
      started_at: now,
    })
    .eq("id", sequenceId)
    .eq("status", "draft");

  await supabase.from("followup_events").insert({
    sequence_id: sequenceId,
    event_type: "approved",
    event_data: {},
  });
  return { ok: true };
}

export async function cancelSequence(
  sequenceId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();
  const { data: seq } = await supabase
    .from("followup_sequences")
    .select("id, status")
    .eq("id", sequenceId)
    .maybeSingle();
  if (!seq) return { ok: false, error: "sequence não encontrada" };
  if (["completed", "cancelled"].includes(seq.status)) {
    return { ok: false, error: `sequence já está '${seq.status}'` };
  }

  const now = new Date().toISOString();
  await supabase
    .from("followup_sequences")
    .update({
      status: "cancelled",
      cancelled_at: now,
      cancelled_reason: reason,
    })
    .eq("id", sequenceId);

  await supabase
    .from("followup_messages")
    .update({ status: "cancelled" })
    .eq("sequence_id", sequenceId)
    .eq("status", "pending");

  await supabase.from("followup_events").insert({
    sequence_id: sequenceId,
    event_type: "cancelled",
    event_data: { reason },
  });
  return { ok: true };
}

export async function pauseSequence(sequenceId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();
  const { data: seq } = await supabase
    .from("followup_sequences")
    .select("id, status")
    .eq("id", sequenceId)
    .maybeSingle();
  if (!seq) return { ok: false, error: "sequence não encontrada" };
  if (!["scheduled", "running"].includes(seq.status)) {
    return { ok: false, error: `sequence está '${seq.status}' — só pausa scheduled/running` };
  }
  await supabase
    .from("followup_sequences")
    .update({ status: "paused", paused_at: new Date().toISOString() })
    .eq("id", sequenceId);
  await supabase.from("followup_events").insert({
    sequence_id: sequenceId,
    event_type: "paused",
    event_data: {},
  });
  return { ok: true };
}

export async function resumeSequence(sequenceId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();
  const { data: seq } = await supabase
    .from("followup_sequences")
    .select("id, status")
    .eq("id", sequenceId)
    .maybeSingle();
  if (!seq) return { ok: false, error: "sequence não encontrada" };
  if (seq.status !== "paused") {
    return { ok: false, error: `sequence está '${seq.status}' — só retoma paused` };
  }
  await supabase
    .from("followup_sequences")
    .update({ status: "running", paused_at: null })
    .eq("id", sequenceId);
  await supabase.from("followup_events").insert({
    sequence_id: sequenceId,
    event_type: "resumed",
    event_data: {},
  });
  return { ok: true };
}

export async function editSequence(
  sequenceId: string,
  edits: { messages?: Array<{ position: number; new_text?: string; new_scheduled_at?: string }> },
): Promise<{ ok: boolean; error?: string; updated_messages: number }> {
  const supabase = createAdminClient();
  let updated = 0;
  for (const edit of edits.messages || []) {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (edit.new_text) updates.message_text = edit.new_text;
    if (edit.new_scheduled_at) updates.scheduled_at = edit.new_scheduled_at;
    if (Object.keys(updates).length === 1) continue;
    const { data } = await supabase
      .from("followup_messages")
      .update(updates)
      .eq("sequence_id", sequenceId)
      .eq("position", edit.position)
      .eq("status", "pending")
      .select("id");
    updated += data?.length ?? 0;
  }
  if (updated > 0) {
    await supabase
      .from("followup_sequences")
      .update({ approval_status: "edited", updated_at: new Date().toISOString() })
      .eq("id", sequenceId);
    await supabase.from("followup_events").insert({
      sequence_id: sequenceId,
      event_type: "edited",
      event_data: { messages_changed: updated },
    });
  }
  return { ok: true, updated_messages: updated };
}
