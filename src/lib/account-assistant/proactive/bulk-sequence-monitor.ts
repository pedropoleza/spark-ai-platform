/**
 * Bulk sequence monitor — pause-on-reply pra sequências em massa (Etapa 4.4).
 *
 * Quando um contato responde a webhook GHL inbound, este módulo é chamado pelo
 * webhook-handler.ts pra detectar se o contato está em alguma sequence_state
 * ativa de bulk_message_jobs cujo step atual (ou o próximo) tem
 * `pause_on_reply=true` — e pausa.
 *
 * Distinção crítica do `sequence-monitor.ts`:
 *   - sequence-monitor.ts cobre `followup_sequences` (feature de 2026-05-18,
 *     follow-up 1-pra-1 criado conversacionalmente pelo SparkBot).
 *   - ESTE arquivo cobre `bulk_message_sequence_state` (campanha em massa
 *     multi-toque do /hub/campaigns). Schemas e regras diferentes — daí 2
 *     monitors separados, sem acoplamento.
 *
 * Pausa cancela TODOS os recipients pending desse contato no job (pra step 2
 * que estava pra disparar não sair), além de marcar o state.
 *
 * Idempotente: roda 2x não duplica nem desfaz pausa.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface BulkPauseResult {
  paused_states: number;
  cancelled_recipients: number;
  job_ids: string[];
}

/**
 * Chamado pelo webhook-handler ao detectar inbound de um contato. Faz:
 *   1. Acha bulk_message_jobs.id da location (filtra antes de querying state)
 *   2. Acha sequence_state ativos COM next_step.pause_on_reply=true
 *      (precisa JOIN com bulk_message_sequences pelo step_number atual+1)
 *   3. Marca state.status='paused_by_reply', paused_at=now
 *   4. Cancela recipients pending desse contato nesses jobs (sem mexer em
 *      sent/failed — apenas remove o que ainda não saiu)
 *
 * Async/silent — não bloqueia inbound se DB cair.
 */
export async function pauseBulkSequencesOnReply(
  contactId: string,
  locationId: string,
): Promise<BulkPauseResult> {
  const result: BulkPauseResult = {
    paused_states: 0,
    cancelled_recipients: 0,
    job_ids: [],
  };

  if (!contactId || !locationId) return result;

  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // 1. Lista bulk_message_jobs da location que TÊM sequence (filtro defensivo
  // pra evitar query desnecessária em jobs single-shot).
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("location_id", locationId)
    .eq("has_sequence", true)
    .in("status", ["running", "paused"]); // paused também pra evitar racing — admin pode reativar
  if (!jobs || jobs.length === 0) return result;
  const jobIds = jobs.map((j) => j.id as string);

  // 2. Busca recipients DO CONTATO nesses jobs (todos status — inclusive
  // pending pra serem cancelados; sent pra achar quais states pausar).
  const { data: recipients } = await supabase
    .from("bulk_message_recipients")
    .select("id, job_id, status, sequence_step")
    .eq("contact_id", contactId)
    .in("job_id", jobIds);
  if (!recipients || recipients.length === 0) return result;

  // 3. Busca sequence_state ativos pra esses recipients.
  const recipientIds = recipients.map((r) => r.id as string);
  const { data: states } = await supabase
    .from("bulk_message_sequence_state")
    .select("id, recipient_id, job_id, current_step, status")
    .in("recipient_id", recipientIds)
    .eq("status", "active");
  if (!states || states.length === 0) return result;

  // 4. Pra cada state, verifica se o PRÓXIMO step (current+1) tem pause_on_reply.
  // (Lógica: pause_on_reply é por step — se o próximo step a sair respeita
  // pausa, fica paused_by_reply. Se NÃO respeita — exemplo, "confirmação de
  // agendamento" mesmo após resposta — segue ativo.)
  type StateRow = {
    id: string;
    recipient_id: string;
    job_id: string;
    current_step: number;
    status: string;
  };
  const typedStates = states as StateRow[];

  for (const st of typedStates) {
    const nextStepNumber = st.current_step + 1;
    const { data: nextStep } = await supabase
      .from("bulk_message_sequences")
      .select("pause_on_reply")
      .eq("job_id", st.job_id)
      .eq("step_number", nextStepNumber)
      .maybeSingle<{ pause_on_reply: boolean }>();

    // Se não tem próximo step OU pause_on_reply=false → ignora.
    if (!nextStep || !nextStep.pause_on_reply) continue;

    // Marca state paused_by_reply (CAS defensivo).
    const { data: updated } = await supabase
      .from("bulk_message_sequence_state")
      .update({
        status: "paused_by_reply",
        paused_at: nowIso,
      })
      .eq("id", st.id)
      .eq("status", "active")
      .select("id");
    if (!updated || updated.length === 0) continue; // alguém já mexeu

    result.paused_states++;
    if (!result.job_ids.includes(st.job_id)) result.job_ids.push(st.job_id);
  }

  // 5. Cancela recipients PENDING desse contato nesses jobs (= mensagens que
  // estavam na fila pra disparar e não devem mais sair). Sent/failed não toca.
  if (result.paused_states > 0) {
    const { data: cancelled } = await supabase
      .from("bulk_message_recipients")
      .update({ status: "cancelled", error_message: "contact_replied" })
      .eq("contact_id", contactId)
      .in("job_id", result.job_ids)
      .eq("status", "pending")
      .select("id");
    result.cancelled_recipients = cancelled?.length ?? 0;
  }

  return result;
}
