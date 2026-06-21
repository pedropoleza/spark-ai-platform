/**
 * Materializador atômico (Pedro 2026-06-20). Plano: EXECUCAO.md (F2 + F6).
 *
 * Transforma o rascunho (task_drafts/draft_steps) em DISPARO REAL e devolve o
 * COUNT REAL de mensagens inseridas — o bot só afirma "agendado" a partir DAQUI
 * (fecha L11: as 7 confirmações falsas da Jussara).
 *
 * ALVO de materialização = tabelas do FOLLOW-UP (followup_sequences +
 * followup_messages), NÃO bulk: um fluxo é N msgs pra 1 contato, e
 * bulk_message_recipients tem UNIQUE(job_id, contact_id) que bloqueia isso. O
 * followup-runner JÁ dispara followup_messages pending (status sequence
 * scheduled/running) com claim atômico + PAUSE-ON-REPLY embutido → reuso total.
 *
 * F6: a MESMA criação por-contato (materializeSequenceForContact) é reusada pra
 * aplicar o fluxo a N contatos (template), sem consumir o rascunho.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDraftWithSteps, transitionDraftStatus, updateDraft, insertTaskEvent } from "@/lib/repositories/task-drafts.repo";
import type { DraftStep } from "./types";
import { DEFAULT_SEND_TIME } from "./config";

export type MaterializeResult =
  | { ok: true; count: number; sequence_id: string; first_at: string; last_at: string }
  | { ok: false; error: string; count: number };

/** UTC instant do "wall-clock" (y,m,d,hh,mm) num timezone IANA. Via Intl (sem lib). */
function zonedWallClockToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(asUtc)).map((x) => [x.type, x.value]));
  const tzLocal = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const offset = tzLocal - asUtc; // ms que o tz está à frente do UTC
  return new Date(asUtc - offset);
}

/** Calendário Y/M/D de (now + offsetDays) no timezone do rep. */
function localDateInTz(now: Date, offsetDays: number, tz: string): { y: number; m: number; d: number } {
  const future = new Date(now.getTime() + offsetDays * 86400000);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(future).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** scheduled_at (UTC) de um passo: (hoje+offset_days) às send_time no fuso do rep. */
export function computeScheduledAt(offsetDays: number, sendTime: string | null, tz: string, now: Date): Date {
  const { y, m, d } = localDateInTz(now, offsetDays, tz);
  const [hhRaw, mmRaw] = (sendTime || DEFAULT_SEND_TIME).split(":");
  const hh = Math.min(23, Math.max(0, parseInt(hhRaw, 10) || 0));
  const mm = Math.min(59, Math.max(0, parseInt(mmRaw, 10) || 0));
  const target = zonedWallClockToUtc(y, m, d, hh, mm, tz);
  return target.getTime() <= now.getTime() ? now : target;
}

/** Texto final do passo: anexa o link de mídia ao texto até a mídia nativa (F4/F5) no runner. */
function composeText(text: string, mediaUrl: string | null): string {
  const t = (text || "").trim();
  if (!mediaUrl) return t || "(sem texto)";
  return t ? `${t}\n${mediaUrl}` : mediaUrl;
}

export interface ContactTarget {
  contact_id: string;
  contact_name?: string | null;
  contact_phone?: string | null;
}

export type SequenceResult =
  | { ok: true; count: number; sequence_id: string; first_at: string; last_at: string }
  | { ok: false; error: string; count: 0 };

/**
 * NÚCLEO reusado (F2 single + F6 N-contatos): cria 1 followup_sequence + N
 * followup_messages pra UM contato e devolve o count REAL. Insert das mensagens
 * checado; se falhar, cancela a sequence (rollback honesto). NÃO mexe no draft.
 */
export async function materializeSequenceForContact(
  supabase: SupabaseClient,
  opts: {
    repId: string;
    locationId: string;
    agentId: string | null;
    target: ContactTarget;
    title: string | null;
    steps: DraftStep[];
    tz: string;
    stopOnReply: boolean;
    draftId: string;
  },
): Promise<SequenceResult> {
  const now = new Date();
  const ordered = opts.steps;
  const schedules = ordered.map((s) => computeScheduledAt(s.offset_days, s.send_time, opts.tz, now));
  const firstAt = schedules.reduce((a, b) => (b < a ? b : a), schedules[0]);
  const lastAt = schedules.reduce((a, b) => (b > a ? b : a), schedules[0]);

  const { data: seq, error: seqErr } = await supabase
    .from("followup_sequences")
    .insert({
      rep_id: opts.repId,
      location_id: opts.locationId,
      agent_id: opts.agentId,
      contact_id: opts.target.contact_id,
      contact_name: opts.target.contact_name || null,
      contact_phone: opts.target.contact_phone || null,
      source: "chat",
      source_metadata: { origin: "task_orchestrator", draft_id: opts.draftId },
      goal: opts.title || "Fluxo de follow-up",
      sequence_type: "custom",
      approval_status: "approved",
      approved_at: now.toISOString(),
      approved_by_rep: true,
      status: "scheduled",
      started_at: now.toISOString(),
      stop_on_reply: opts.stopOnReply,
      total_messages: ordered.length,
      scheduled_first_at: firstAt.toISOString(),
      scheduled_last_at: lastAt.toISOString(),
    })
    .select("id")
    .single();
  if (seqErr || !seq) {
    return { ok: false, error: `erro ao criar sequência (${seqErr?.message || "?"})`, count: 0 };
  }
  const sequenceId = seq.id as string;

  const rows = ordered.map((s, i) => ({
    sequence_id: sequenceId,
    position: i + 1,
    message_text: composeText(s.message_text, s.media_url),
    scheduled_at: schedules[i].toISOString(),
    status: "pending",
    requires_final_check: false,
  }));
  const { data: insMsgs, error: msgErr } = await supabase.from("followup_messages").insert(rows).select("id");
  const realCount = insMsgs?.length ?? 0;
  if (msgErr || realCount !== ordered.length) {
    // Rollback honesto: cancela a sequence (não fica meia-feita).
    await supabase.from("followup_sequences").update({
      status: "cancelled", cancelled_at: now.toISOString(), cancelled_reason: "materialize_partial",
    }).eq("id", sequenceId);
    return { ok: false, error: `entraram ${realCount} de ${ordered.length} mensagens — revertido`, count: 0 };
  }
  return { ok: true, count: realCount, sequence_id: sequenceId, first_at: firstAt.toISOString(), last_at: lastAt.toISOString() };
}

/**
 * Materializa 1 draft pra o contato ALVO do próprio draft (meta.contact_id).
 * Idempotente via transição de status (building/ready → materializing → materialized).
 */
export async function materializeDraft(
  repId: string,
  draftId: string,
  repTimezone: string | null,
): Promise<MaterializeResult> {
  const supabase = createAdminClient();
  const dws = await getDraftWithSteps(draftId);
  if (!dws) return { ok: false, error: "Rascunho não encontrado.", count: 0 };
  if (dws.draft.rep_id !== repId) return { ok: false, error: "Esse rascunho não é seu.", count: 0 };
  if (dws.steps.length === 0) return { ok: false, error: "O fluxo está vazio — adicione passos antes de disparar.", count: 0 };

  const meta = (dws.draft.meta || {}) as Record<string, unknown>;
  const contactId = meta.contact_id as string | undefined;
  if (!contactId) {
    return { ok: false, error: "Falta o contato alvo. Use set_task_meta com contact_id antes de disparar.", count: 0 };
  }

  // GUARD de materialização (anti dupla-execução / anti-alucinação de status).
  const t = await transitionDraftStatus(draftId, ["building", "ready_for_review"], "materializing");
  if (!t.ok || t.affected === 0) {
    return { ok: false, error: "Esse fluxo já está sendo disparado ou já foi (não materializo de novo).", count: 0 };
  }

  const res = await materializeSequenceForContact(supabase, {
    repId,
    locationId: dws.draft.location_id,
    agentId: dws.draft.agent_id,
    target: { contact_id: contactId, contact_name: meta.contact_name as string, contact_phone: meta.contact_phone as string },
    title: dws.draft.title,
    steps: dws.steps,
    tz: repTimezone || "America/New_York",
    stopOnReply: meta.stop_on_reply !== false,
    draftId,
  });

  if (!res.ok) {
    await transitionDraftStatus(draftId, ["materializing"], "failed");
    await insertTaskEvent(draftId, "materialize_failed", { error: res.error });
    return { ok: false, error: `Falha ao agendar: ${res.error}. NADA foi agendado.`, count: 0 };
  }

  await transitionDraftStatus(draftId, ["materializing"], "materialized", {
    materialized_count: res.count,
    materialized_at: new Date().toISOString(),
  });
  const newMeta = { ...meta, materialized_sequence_ids: [...((meta.materialized_sequence_ids as string[]) || []), res.sequence_id] };
  await updateDraft(draftId, { meta: newMeta });
  await insertTaskEvent(draftId, "committed", { sequence_id: res.sequence_id, count: res.count });
  return { ok: true, count: res.count, sequence_id: res.sequence_id, first_at: res.first_at, last_at: res.last_at };
}

export interface ApplyResult {
  ok: boolean;
  total_contacts: number;
  succeeded: number;
  total_messages: number;
  per_contact: Array<{ contact_id: string; ok: boolean; count: number; sequence_id?: string; error?: string }>;
}

/**
 * F6 — aplica o fluxo (template) a N contatos: 1 followup_sequence por contato,
 * reusando o núcleo. NÃO consome o rascunho (continua reusável). Count REAL por
 * contato — o bot reporta exatamente quantos entraram em cada um.
 */
export async function applyFlowToContacts(
  repId: string,
  draftId: string,
  contacts: ContactTarget[],
  repTimezone: string | null,
): Promise<{ ok: false; error: string } | ApplyResult> {
  const supabase = createAdminClient();
  const dws = await getDraftWithSteps(draftId);
  if (!dws) return { ok: false, error: "Rascunho não encontrado." };
  if (dws.draft.rep_id !== repId) return { ok: false, error: "Esse rascunho não é seu." };
  if (dws.steps.length === 0) return { ok: false, error: "O fluxo está vazio — adicione passos antes de aplicar." };
  const valid = contacts.filter((c) => c.contact_id);
  if (valid.length === 0) return { ok: false, error: "Nenhum contato válido pra aplicar (faltou contact_id)." };

  const tz = repTimezone || "America/New_York";
  const stopOnReply = (dws.draft.meta as Record<string, unknown>)?.stop_on_reply !== false;
  const per: ApplyResult["per_contact"] = [];
  const seqIds: string[] = [];

  for (const c of valid) {
    const res = await materializeSequenceForContact(supabase, {
      repId, locationId: dws.draft.location_id, agentId: dws.draft.agent_id,
      target: c, title: dws.draft.title, steps: dws.steps, tz, stopOnReply, draftId,
    });
    if (res.ok) {
      per.push({ contact_id: c.contact_id, ok: true, count: res.count, sequence_id: res.sequence_id });
      seqIds.push(res.sequence_id);
    } else {
      per.push({ contact_id: c.contact_id, ok: false, count: 0, error: res.error });
    }
  }

  // Append dos sequence_ids no meta (rastreável); NÃO transiciona status (reusável).
  const meta = (dws.draft.meta || {}) as Record<string, unknown>;
  const applied = [...((meta.applied_sequence_ids as string[]) || []), ...seqIds];
  await updateDraft(draftId, { meta: { ...meta, applied_sequence_ids: applied } });
  await insertTaskEvent(draftId, "applied_to_contacts", {
    total: valid.length, succeeded: seqIds.length, sequence_ids: seqIds,
  });

  const succeeded = per.filter((p) => p.ok).length;
  return {
    ok: true,
    total_contacts: valid.length,
    succeeded,
    total_messages: per.reduce((a, p) => a + p.count, 0),
    per_contact: per,
  };
}

/** Progresso REAL de um draft materializado/aplicado (lê o estado das followup_messages). */
export async function getDraftProgress(
  draftId: string,
): Promise<{ ok: true; total: number; sent: number; pending: number; skipped: number; failed: number } | { ok: false; error: string }> {
  const supabase = createAdminClient();
  const dws = await getDraftWithSteps(draftId);
  if (!dws) return { ok: false, error: "Rascunho não encontrado." };
  const meta = (dws.draft.meta as Record<string, unknown>) || {};
  const seqIds = [
    ...((meta.materialized_sequence_ids as string[]) || []),
    ...((meta.applied_sequence_ids as string[]) || []),
  ];
  if (seqIds.length === 0) return { ok: false, error: "Esse fluxo ainda não foi disparado (sem sequência materializada)." };
  const { data, error } = await supabase.from("followup_messages").select("status").in("sequence_id", seqIds);
  if (error) return { ok: false, error: "Erro ao ler o progresso." };
  const rows = data || [];
  const by = (st: string) => rows.filter((r) => r.status === st).length;
  return { ok: true, total: rows.length, sent: by("sent"), pending: by("pending"), skipped: by("skipped"), failed: by("failed") };
}
