/**
 * Sequence runner (Etapa 4.4 — Pedro 2026-05-28).
 *
 * Avança bulk_message_sequence_state quando o delay do próximo step vence.
 * Roda dentro do cron principal (/api/cron/sparkbot-proactive) a cada 30s,
 * antes do bulk-message-runner (que dispara recipients pendentes).
 *
 * Modelo de estado:
 *   - state.current_step = último step DISPARADO pra esse contato
 *   - state.next_send_at = quando o PRÓXIMO step (current+1) deve sair
 *   - state.status = 'active' enquanto tem próximo step a disparar
 *
 * Quando next_send_at vence:
 *   1. Cria novo bulk_message_recipients row pro step current+1 (com
 *      message_template_override = template do step).
 *   2. Avança state.current_step.
 *   3. Se existe step current+2: state.next_send_at = now + delay_days do
 *      step current+2. Se não: state.status='completed'.
 *
 * Pause-on-reply é tratado em sequence-monitor (hook do webhook inbound),
 * não aqui. Aqui só processamos states active.
 *
 * Flag-gate: BULK_SEQUENCES_ENABLED. Default OFF até admin ligar
 * conscientemente após smoke. Quando "1", roda no cron.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";

const MAX_PER_TICK = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
// Jitter pequeno pra steps subsequentes não saírem todos exatamente juntos.
const STEP_DISPATCH_JITTER_SECONDS = 60;

export interface SequenceRunResult {
  advanced: number;
  completed: number;
  failed: number;
  skipped_paused_job: number;
}

interface SequenceStateRow {
  id: string;
  recipient_id: string;
  job_id: string;
  current_step: number;
  next_send_at: string;
  status: string;
}

interface SequenceRow {
  step_number: number;
  template: string;
  delay_days: number;
  pause_on_reply: boolean;
}

interface RecipientSnapshot {
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
}

/**
 * Tick principal. Flag-gated. Roda no cron principal antes do bulk-runner.
 */
export async function processSequenceSteps(): Promise<SequenceRunResult> {
  if (process.env.BULK_SEQUENCES_ENABLED !== "1") {
    return { advanced: 0, completed: 0, failed: 0, skipped_paused_job: 0 };
  }
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  const result: SequenceRunResult = {
    advanced: 0,
    completed: 0,
    failed: 0,
    skipped_paused_job: 0,
  };

  // 1. Busca states vencidos. ORDER BY next_send_at asc pra ordem temporal.
  const { data: states, error: stErr } = await supabase
    .from("bulk_message_sequence_state")
    .select("id, recipient_id, job_id, current_step, next_send_at, status")
    .eq("status", "active")
    .lte("next_send_at", nowIso)
    .order("next_send_at", { ascending: true })
    .limit(MAX_PER_TICK);

  if (stErr) {
    console.warn("[seq-runner] SELECT states falhou:", stErr.message);
    return result;
  }
  if (!states || states.length === 0) return result;

  // 2. Pra cada state, processa avanço. Single-runner por design (cron único),
  // mas usa atomic CAS no UPDATE pra defender de race teórica.
  for (const state of states as SequenceStateRow[]) {
    try {
      const stepResult = await advanceState(state, nowIso);
      if (stepResult === "advanced") result.advanced++;
      else if (stepResult === "completed") result.completed++;
      else if (stepResult === "skipped_paused_job") result.skipped_paused_job++;
      else if (stepResult === "failed") result.failed++;
    } catch (err) {
      result.failed++;
      console.warn(
        `[seq-runner] state ${state.id} falhou:`,
        err instanceof Error ? err.message.slice(0, 200) : err,
      );
      // Sweep F49 2026-06-05: avanço de estado da sequência falhou (estado pode
      // travar — lead não avança nos passos).
      reportError({ title: "Sequence runner: avanço de estado falhou", feature: "proactive-sequence", severity: "medium", error: err, metadata: { stateId: state.id } });
    }
  }

  return result;
}

type AdvanceOutcome = "advanced" | "completed" | "skipped_paused_job" | "failed";

async function advanceState(
  state: SequenceStateRow,
  nowIso: string,
): Promise<AdvanceOutcome> {
  const supabase = createAdminClient();
  const nextStepNumber = state.current_step + 1;

  // 1. Confirma que o job ainda está running. Se pausou/cancelou, pula sem
  // mudar state (fica pra retomar quando voltar pra running).
  const { data: job } = await supabase
    .from("bulk_message_jobs")
    .select("id, status, location_id, agent_id, message_template")
    .eq("id", state.job_id)
    .maybeSingle();
  if (!job) {
    // Job sumiu (delete?). Marca state como cancelado.
    await supabase
      .from("bulk_message_sequence_state")
      .update({ status: "cancelled", completed_at: nowIso })
      .eq("id", state.id);
    return "failed";
  }
  if (job.status !== "running") {
    return "skipped_paused_job";
  }

  // 2. Lookup do PRÓXIMO step (template+pause_on_reply). Se não existe, state
  // estava em current_step = último step e nada mais a fazer → completed.
  const { data: nextStep } = await supabase
    .from("bulk_message_sequences")
    .select("step_number, template, delay_days, pause_on_reply")
    .eq("job_id", state.job_id)
    .eq("step_number", nextStepNumber)
    .maybeSingle<SequenceRow>();

  if (!nextStep) {
    // current_step já era o último → completa.
    await supabase
      .from("bulk_message_sequence_state")
      .update({ status: "completed", completed_at: nowIso })
      .eq("id", state.id)
      .eq("status", "active"); // CAS defensivo
    return "completed";
  }

  // 3. Hidrata recipient original pra extrair contact_*. NÃO mexe nele.
  const { data: original } = await supabase
    .from("bulk_message_recipients")
    .select("contact_id, contact_name, contact_phone")
    .eq("id", state.recipient_id)
    .maybeSingle<RecipientSnapshot>();
  if (!original || !original.contact_id) {
    await supabase
      .from("bulk_message_sequence_state")
      .update({ status: "cancelled", completed_at: nowIso })
      .eq("id", state.id);
    return "failed";
  }

  // 4. INSERT novo recipient pro próximo step. message_template_override
  // garante que o bulk-runner usa o template DESTE step (não do job).
  // Jitter pra steps não saírem todos no mesmo segundo.
  const jitterMs = Math.floor(Math.random() * STEP_DISPATCH_JITTER_SECONDS * 1000);
  const scheduledAt = new Date(Date.now() + jitterMs).toISOString();
  const { error: insErr } = await supabase
    .from("bulk_message_recipients")
    .insert({
      job_id: state.job_id,
      contact_id: original.contact_id,
      contact_name: original.contact_name,
      contact_phone: original.contact_phone,
      scheduled_at: scheduledAt,
      status: "pending",
      message_template_override: nextStep.template,
      sequence_step: nextStepNumber,
    });
  if (insErr) {
    console.warn(
      `[seq-runner] INSERT recipient falhou (state ${state.id}):`,
      insErr.message,
    );
    return "failed";
  }

  // 5. Avança state: current_step++. Próximo next_send_at depende de SE
  // existe step current+2 (= nextStepNumber+1).
  const { data: stepAfterNext } = await supabase
    .from("bulk_message_sequences")
    .select("step_number, delay_days")
    .eq("job_id", state.job_id)
    .eq("step_number", nextStepNumber + 1)
    .maybeSingle<{ step_number: number; delay_days: number }>();

  if (!stepAfterNext) {
    // nextStep era o ÚLTIMO. Marca state completed (já enfileiramos o último).
    await supabase
      .from("bulk_message_sequence_state")
      .update({
        current_step: nextStepNumber,
        status: "completed",
        completed_at: nowIso,
      })
      .eq("id", state.id)
      .eq("status", "active"); // CAS
    return "completed";
  }

  const nextSendAt = new Date(Date.now() + stepAfterNext.delay_days * DAY_MS).toISOString();
  await supabase
    .from("bulk_message_sequence_state")
    .update({
      current_step: nextStepNumber,
      next_send_at: nextSendAt,
    })
    .eq("id", state.id)
    .eq("status", "active"); // CAS

  return "advanced";
}
