/**
 * Materializador atômico (Pedro 2026-06-20). Plano: EXECUCAO.md (F2 — P0 honestidade).
 *
 * Transforma o rascunho (task_drafts/draft_steps) em DISPARO REAL e devolve o
 * COUNT REAL de mensagens inseridas — o bot só afirma "agendado" a partir DAQUI
 * (fecha L11: as 7 confirmações falsas da Jussara).
 *
 * ALVO de materialização = tabelas do FOLLOW-UP (followup_sequences +
 * followup_messages), NÃO bulk: um fluxo é N msgs pra 1 contato, e
 * bulk_message_recipients tem UNIQUE(job_id, contact_id) que bloqueia isso. O
 * followup-runner JÁ dispara followup_messages pending (status sequence
 * scheduled/running) com claim atômico + PAUSE-ON-REPLY embutido → reuso total,
 * zero runner novo, e o F3 (parar quando o lead responde) vem de graça.
 *
 * Honestidade: transição de status com guard (não materializa 2x); checa o error
 * do INSERT das mensagens; se falhar, marca a sequence cancelled + o draft failed
 * e devolve count 0 + erro. Nunca "agendado" sem rows.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getDraftWithSteps, transitionDraftStatus, updateDraft, insertTaskEvent } from "@/lib/repositories/task-drafts.repo";
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
  // Se já passou (ex: Dia 0 com hora vencida), dispara agora — não espera 1 dia.
  return target.getTime() <= now.getTime() ? now : target;
}

/** Texto final do passo: anexa o link de mídia ao texto até a mídia nativa (F4) existir. */
function composeText(text: string, mediaUrl: string | null): string {
  const t = (text || "").trim();
  if (!mediaUrl) return t || "(sem texto)";
  return t ? `${t}\n${mediaUrl}` : mediaUrl;
}

/**
 * Materializa 1 draft pra 1 contato. Idempotente via transição de status
 * (building/ready_for_review → materializing). Devolve count REAL.
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

  const tz = repTimezone || "America/New_York";
  const now = new Date();
  // Ordem canônica (offset_days, intra_day, position) — já vem ordenado do repo.
  const ordered = dws.steps;
  const schedules = ordered.map((s) => computeScheduledAt(s.offset_days, s.send_time, tz, now));
  const firstAt = schedules.reduce((a, b) => (b < a ? b : a), schedules[0]);
  const lastAt = schedules.reduce((a, b) => (b > a ? b : a), schedules[0]);
  const stopOnReply = meta.stop_on_reply === false ? false : true;

  // 1. Cria a sequence (status 'scheduled' → o followup-runner pega).
  const { data: seq, error: seqErr } = await supabase
    .from("followup_sequences")
    .insert({
      rep_id: repId,
      location_id: dws.draft.location_id,
      agent_id: dws.draft.agent_id,
      contact_id: contactId,
      contact_name: (meta.contact_name as string) || null,
      contact_phone: (meta.contact_phone as string) || null,
      source: "chat",
      source_metadata: { origin: "task_orchestrator", draft_id: draftId },
      goal: dws.draft.title || "Fluxo de follow-up",
      sequence_type: "custom",
      approval_status: "approved",
      approved_at: now.toISOString(),
      approved_by_rep: true,
      status: "scheduled",
      started_at: now.toISOString(),
      stop_on_reply: stopOnReply,
      total_messages: ordered.length,
      scheduled_first_at: firstAt.toISOString(),
      scheduled_last_at: lastAt.toISOString(),
    })
    .select("id")
    .single();
  if (seqErr || !seq) {
    await transitionDraftStatus(draftId, ["materializing"], "failed");
    await insertTaskEvent(draftId, "materialize_failed", { stage: "sequence", error: seqErr?.message });
    return { ok: false, error: "Não consegui criar a sequência (erro no banco). NADA foi agendado.", count: 0 };
  }
  const sequenceId = seq.id as string;

  // 2. Insere as N mensagens (count REAL = o que entrar).
  const rows = ordered.map((s, i) => ({
    sequence_id: sequenceId,
    position: i + 1,
    message_text: composeText(s.message_text, s.media_url),
    scheduled_at: schedules[i].toISOString(),
    status: "pending",
    requires_final_check: false, // conteúdo é autoral do rep + já revisado na montagem
  }));
  const { data: insMsgs, error: msgErr } = await supabase
    .from("followup_messages")
    .insert(rows)
    .select("id");
  const realCount = insMsgs?.length ?? 0;

  if (msgErr || realCount !== ordered.length) {
    // Rollback honesto: cancela a sequence + marca draft failed. Bot NÃO diz "agendado".
    await supabase.from("followup_sequences").update({ status: "cancelled", cancelled_at: now.toISOString(), cancelled_reason: "materialize_partial" }).eq("id", sequenceId);
    await transitionDraftStatus(draftId, ["materializing"], "failed");
    await insertTaskEvent(draftId, "materialize_failed", { stage: "messages", inserted: realCount, expected: ordered.length, error: msgErr?.message });
    return {
      ok: false,
      error: `Falha ao agendar as mensagens (entraram ${realCount} de ${ordered.length}). Reverti tudo — NADA foi agendado.`,
      count: 0,
    };
  }

  // 3. Sucesso: promove o draft pra 'materialized' com o count REAL.
  await transitionDraftStatus(draftId, ["materializing"], "materialized", {
    materialized_count: realCount,
    materialized_at: now.toISOString(),
  });
  const newMeta = { ...meta, materialized_sequence_ids: [...((meta.materialized_sequence_ids as string[]) || []), sequenceId] };
  await updateDraft(draftId, { meta: newMeta });
  await insertTaskEvent(draftId, "committed", { sequence_id: sequenceId, count: realCount });

  return { ok: true, count: realCount, sequence_id: sequenceId, first_at: firstAt.toISOString(), last_at: lastAt.toISOString() };
}

/** Progresso REAL de um draft materializado (lê o estado das followup_messages). */
export async function getDraftProgress(
  draftId: string,
): Promise<{ ok: true; total: number; sent: number; pending: number; skipped: number; failed: number } | { ok: false; error: string }> {
  const supabase = createAdminClient();
  const dws = await getDraftWithSteps(draftId);
  if (!dws) return { ok: false, error: "Rascunho não encontrado." };
  const seqIds = ((dws.draft.meta as Record<string, unknown>)?.materialized_sequence_ids as string[]) || [];
  if (seqIds.length === 0) return { ok: false, error: "Esse fluxo ainda não foi disparado (sem sequência materializada)." };
  const { data, error } = await supabase
    .from("followup_messages")
    .select("status")
    .in("sequence_id", seqIds);
  if (error) return { ok: false, error: "Erro ao ler o progresso." };
  const rows = data || [];
  const by = (st: string) => rows.filter((r) => r.status === st).length;
  return {
    ok: true,
    total: rows.length,
    sent: by("sent"),
    pending: by("pending"),
    skipped: by("skipped"),
    failed: by("failed"),
  };
}
