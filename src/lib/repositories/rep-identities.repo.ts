/**
 * Repositório para a tabela `rep_identities`.
 *
 * Encapsula o nome da tabela e das colunas. Cada função replica EXATAMENTE
 * a query do call site original — sem adicionar lógica de negócio.
 *
 * ⚠️ NÃO migrar para este repo:
 *   - `identifyRep` em identity.ts: todo o fluxo de lookup + INSERT com
 *     captura de 23505 é parte da camada de idempotência (Track 1 C3).
 *     As queries ali estão entrelaçadas com race conditions multi-webhook.
 *   - webhook-handler.ts: o UPDATE de silence reset (after INSERT user msg)
 *     deve permanecer junto com o INSERT do user msg na mesma sequência
 *     lógica para garantir atomicidade comportamental.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { RepIdentity, RepProfile } from "@/types/account-assistant";

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Busca rep_identity por phone (single candidate, já normalizado).
 * Usado em identity.ts como parte do lookup multi-candidate.
 *
 * Nota: o loop de generatePhoneCandidates e o INSERT com 23505 em
 * identifyRep() NÃO foram movidos pra cá — ficam em identity.ts.
 */
export async function findRepByPhone(
  phone: string,
): Promise<RepIdentity | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("rep_identities")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  return (data as RepIdentity | null) ?? null;
}

/**
 * Busca rep_identity por id (select completo).
 */
export async function findRepById(repId: string): Promise<RepIdentity | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("rep_identities")
    .select("*")
    .eq("id", repId)
    .maybeSingle();
  return (data as RepIdentity | null) ?? null;
}

/**
 * Busca rep_identity por id selecionando apenas campos específicos.
 * Usado em followup-completion-notifier e outros que precisam de subset.
 */
export async function findRepFieldsById<T = Partial<RepIdentity>>(
  repId: string,
  fields: string,
): Promise<T | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("rep_identities")
    .select(fields)
    .eq("id", repId)
    .maybeSingle();
  return (data as T | null) ?? null;
}

/**
 * Busca rep por id retornando apenas id + phone (uso em reminder-runner
 * e whatsapp-delivery).
 */
export async function findRepPhoneById(
  repId: string,
): Promise<{ id: string; phone: string } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("rep_identities")
    .select("id, phone")
    .eq("id", repId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Count de reps ativos (para dashboard admin). Cada chamada é para uma
 * janela de tempo diferente.
 */
export async function countActiveReps(
  cutoffIso: string,
): Promise<number | null> {
  const supabase = createAdminClient();
  const { count } = await supabase
    .from("rep_identities")
    .select("id", { count: "exact", head: true })
    .gte("last_inbound_at", cutoffIso);
  return count ?? null;
}

/**
 * Count de reps externos (não internos).
 */
export async function countExternalReps(): Promise<number | null> {
  const supabase = createAdminClient();
  const { count } = await supabase
    .from("rep_identities")
    .select("id", { count: "exact", head: true })
    .eq("is_internal", false);
  return count ?? null;
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/**
 * Atualiza campos de um rep por id. Merge parcial — caller passa só as
 * chaves que quer mudar.
 */
export async function updateRepById(
  repId: string,
  patch: Partial<RepIdentity>,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update(patch)
    .eq("id", repId);
}

/**
 * Marca terms como aceitos.
 * Extrai query de identity.ts:acceptTerms — mantém função lá como wrapper
 * retrocompat.
 */
export async function setTermsAccepted(repId: string, isoDate: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ terms_accepted_at: isoDate })
    .eq("id", repId);
}

/**
 * Marca terms como rejeitados.
 * Fix CRITICAL Track 1 C1: ver identity.ts:rejectTerms para contexto.
 */
export async function setTermsRejected(repId: string, isoDate: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ terms_rejected_at: isoDate })
    .eq("id", repId);
}

// --- Terms PARTE 2 (campanha de grupo) -------------------------------------
// Espelham os setters acima, trocando só a coluna. Ver migration 00113.

/**
 * Marca a Parte 2 (campanha de grupo) como aceita e LIMPA pending + rejected
 * (reject de grupo é reversível — aceitar depois apaga a recusa anterior).
 */
export async function setGroupCampaignTermsAccepted(
  repId: string,
  isoDate: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("rep_identities")
    .update({
      group_campaign_terms_accepted_at: isoDate,
      group_campaign_terms_pending_at: null,
      group_campaign_terms_rejected_at: null,
    })
    .eq("id", repId);
  if (error) console.warn(`[group-terms] accept update falhou (${repId}):`, error.message);
}

/** Marca a Parte 2 como recusada e LIMPA o pending. NÃO silencia o SparkBot. */
export async function setGroupCampaignTermsRejected(
  repId: string,
  isoDate: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("rep_identities")
    .update({ group_campaign_terms_rejected_at: isoDate, group_campaign_terms_pending_at: null })
    .eq("id", repId);
  if (error) console.warn(`[group-terms] reject update falhou (${repId}):`, error.message);
}

/**
 * Marca que o rep entrou no fluxo de aceite da Parte 2 (gate determinístico).
 * LIMPA rejected_at: reject de grupo é reversível, re-entrar zera a recusa pra o
 * gate 1b do processor poder capturar o novo accept/reject.
 */
export async function setGroupCampaignTermsPending(
  repId: string,
  isoDate: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("rep_identities")
    .update({ group_campaign_terms_pending_at: isoDate, group_campaign_terms_rejected_at: null })
    .eq("id", repId);
  if (error) console.warn(`[group-terms] pending update falhou (${repId}):`, error.message);
}

/**
 * Limpa o pending da Parte 2 SEM registrar aceite/recusa. Usado quando a resposta
 * é ambígua (rep mudou de assunto) — evita prender o rep no gate de termos.
 */
export async function clearGroupCampaignTermsPending(repId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("rep_identities")
    .update({ group_campaign_terms_pending_at: null })
    .eq("id", repId);
  if (error) console.warn(`[group-terms] clear pending falhou (${repId}):`, error.message);
}

/**
 * Seta active_location_id do rep.
 */
export async function setActiveLocation(
  repId: string,
  locationId: string,
  updatedAt: string,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ active_location_id: locationId, updated_at: updatedAt })
    .eq("id", repId);
}

/**
 * Confirma timezone do rep (onboarding automático ou via tool).
 * Idempotente: caller deve checar timezone_confirmed_at antes de chamar
 * se quiser evitar sobrescrita de override manual.
 */
export async function setRepTimezone(
  repId: string,
  timezone: string,
  confirmedAt: string,
  updatedAt: string,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ timezone, timezone_confirmed_at: confirmedAt, updated_at: updatedAt })
    .eq("id", repId);
}

/**
 * Atualiza profile do rep (merge raso — só as chaves em `profilePatch`).
 * Replica lógica de identity.ts:updateRepProfile.
 */
export async function mergeRepProfile(
  repId: string,
  profilePatch: Partial<RepProfile>,
): Promise<void> {
  const supabase = createAdminClient();
  const { data: current } = await supabase
    .from("rep_identities")
    .select("profile")
    .eq("id", repId)
    .maybeSingle();
  const merged = { ...(current?.profile || {}), ...profilePatch };
  await supabase
    .from("rep_identities")
    .update({ profile: merged, updated_at: new Date().toISOString() })
    .eq("id", repId);
}

/**
 * Reset silence tracking: limpa contadores após inbound do rep.
 * Replica o UPDATE de webhook-handler.ts (executado após INSERT do user msg).
 *
 * ⚠️ Atenção: NÃO use esta função no webhook-handler.ts — o silence reset
 * ali deve continuar inline após o INSERT do user msg para manter a
 * sequência lógica e facilitar rastreamento de bugs futuros.
 * Esta função é para outros callers (testes, scripts de manutenção, etc).
 */
export async function resetSilenceTracking(repId: string, inboundAt: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({
      last_inbound_at: inboundAt,
      consecutive_proactive_without_reply: 0,
      proactive_paused_at: null,
      proactive_warned_at: null,
    })
    .eq("id", repId);
}
