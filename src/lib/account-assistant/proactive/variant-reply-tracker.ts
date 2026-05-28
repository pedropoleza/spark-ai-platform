/**
 * Variant reply tracker (Etapa 4.7 final — Pedro 2026-05-28).
 *
 * Quando um contato responde inbound, este módulo procura o `bulk_message_recipients`
 * mais recente que ENVIOU pra esse contato nos últimos 7d e marca `replied_at`.
 * Útil pra calcular reply rate por variant (A/B).
 *
 * Diferente do `bulk-sequence-monitor` (que pausa sequência) — este só ANOTA.
 * Ordem chain: pause → opt-out → variant-reply (todos disparam em paralelo).
 *
 * Idempotente: se replied_at já está setado, não sobrescreve.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const REPLY_LOOKBACK_DAYS = 7;

export interface VariantReplyResult {
  matched: boolean;
  recipient_id?: string;
  job_id?: string;
  variant_id?: number | null;
  sequence_step?: number | null;
}

/**
 * Busca o recipient enviado mais recente nos últimos 7d e marca replied_at.
 * Async/silent — não bloqueia inbound se DB cair.
 */
export async function trackVariantReply(
  contactId: string,
  locationId: string,
): Promise<VariantReplyResult> {
  const result: VariantReplyResult = { matched: false };

  if (!contactId || !locationId) return result;

  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - REPLY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // 1. Lista jobs da location (anti-IDOR). Sem filtro de status porque jobs
  // já completos também devem registrar reply rate.
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("location_id", locationId);
  if (!jobs || jobs.length === 0) return result;
  const jobIds = jobs.map((j) => j.id as string);

  // 2. Busca recipient enviado mais recente nessa janela. ORDER BY sent_at DESC
  // pega o último — se contato recebeu múltiplas campanhas, a mais recente é
  // a que provavelmente provocou o reply.
  const { data: recipient } = await supabase
    .from("bulk_message_recipients")
    .select("id, job_id, variant_id, sequence_step, replied_at")
    .eq("contact_id", contactId)
    .in("job_id", jobIds)
    .eq("status", "sent")
    .gte("sent_at", cutoffIso)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!recipient) return result;
  // Idempotente: já marcado, não toca.
  if (recipient.replied_at) {
    return {
      matched: true,
      recipient_id: recipient.id as string,
      job_id: recipient.job_id as string,
      variant_id: (recipient.variant_id as number | null) ?? null,
      sequence_step: (recipient.sequence_step as number | null) ?? null,
    };
  }

  // 3. Marca replied_at = now. CAS defensivo: só atualiza se ainda NULL.
  const nowIso = new Date().toISOString();
  await supabase
    .from("bulk_message_recipients")
    .update({ replied_at: nowIso })
    .eq("id", recipient.id as string)
    .is("replied_at", null);

  return {
    matched: true,
    recipient_id: recipient.id as string,
    job_id: recipient.job_id as string,
    variant_id: (recipient.variant_id as number | null) ?? null,
    sequence_step: (recipient.sequence_step as number | null) ?? null,
  };
}
