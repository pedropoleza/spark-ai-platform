/**
 * Repositório para a tabela `usage_records`.
 *
 * Encapsula o nome da tabela e das colunas. Cada função replica EXATAMENTE
 * a query do call site original — sem adicionar lógica de negócio.
 *
 * A maior parte das queries de billing/charge.ts é complexa (claim atômico,
 * retry de unbilled records, etc.) e permanece em charge.ts para manter
 * a clareza do fluxo P1. As funções aqui cobrem os casos simples:
 * INSERT de novo record, UPDATE de campos individuais, e SELECTs de dashboard.
 */

import { createAdminClient } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Tipos auxiliares
// ---------------------------------------------------------------------------

export interface UsageRecordInsert {
  location_id: string;
  agent_id: string;
  contact_id?: string | null;
  action_type: string;
  ai_model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  audio_seconds: number;
  image_count: number;
  cost_usd: number;
  markup_usd: number;
  total_charge_usd: number;
  uses_custom_key: boolean;
  charged_to_wallet: boolean;
}

export interface UsageRecordRow extends UsageRecordInsert {
  id: string;
  created_at: string;
  charged_to_wallet: boolean;
  wallet_charge_id?: string | null;
  cap_blocked?: boolean;
  claim_token?: string | null;
  claimed_at?: string | null;
  charged_at?: string | null;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Soma cost_usd e total_charge_usd de um período (para dashboard admin).
 */
export async function sumUsageCosts(
  cutoffIso: string,
): Promise<Array<{ cost_usd: number; total_charge_usd: number }>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("usage_records")
    .select("cost_usd, total_charge_usd")
    .gte("created_at", cutoffIso);
  return (data ?? []) as Array<{ cost_usd: number; total_charge_usd: number }>;
}

/**
 * Seleciona campos de usage pra breakdown por type+location (dashboard billing).
 */
export async function getUsageBreakdown(
  cutoffIso: string,
): Promise<Array<{ action_type: string; location_id: string; total_charge_usd: number }>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("usage_records")
    .select("action_type, location_id, total_charge_usd")
    .gte("created_at", cutoffIso);
  return (data ?? []) as Array<{ action_type: string; location_id: string; total_charge_usd: number }>;
}

/**
 * Busca total_charge_usd de uma location no mês corrente (para cap check).
 * Replica query de billing/charge.ts:isMonthlyCapReached.
 *
 * Conta TODOS os records com total_charge_usd > 0 (exceto cap_blocked),
 * independente de charged_to_wallet — pois records com GHL 5xx ficam
 * charged_to_wallet=false mas já contam pro cap (Fix Track 10 C2).
 */
export async function getMonthlySpend(
  locationId: string,
  startOfMonthIso: string,
): Promise<Array<{ total_charge_usd: number }>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("usage_records")
    .select("total_charge_usd")
    .eq("location_id", locationId)
    .gte("created_at", startOfMonthIso)
    .gt("total_charge_usd", 0);
  return (data ?? []) as Array<{ total_charge_usd: number }>;
}

/**
 * Busca records não cobrados e antigos (para alerta de billing).
 * Replica query de billing/charge.ts:chargeUnbilledRecords (parte do alerta).
 */
export async function findStaleUnbilledRecords(
  cutoffIso: string,
): Promise<Array<{ id: string; total_charge_usd: number }>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("usage_records")
    .select("id, total_charge_usd")
    .eq("charged_to_wallet", false)
    .eq("uses_custom_key", false)
    .gt("total_charge_usd", 0)
    .lt("created_at", cutoffIso);
  return (data ?? []) as Array<{ id: string; total_charge_usd: number }>;
}

/**
 * Busca records para o billing report da location (rota /api/billing).
 */
export async function getLocationBillingRecords(
  locationId: string,
  limit: number,
): Promise<UsageRecordRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("usage_records")
    .select("*")
    .eq("location_id", locationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as UsageRecordRow[];
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/**
 * Insere um novo usage_record e retorna o id.
 * Replica o INSERT de billing/charge.ts:trackAndCharge.
 *
 * Não lança exceção em erro — retorna null e loga para manter comportamento
 * idêntico ao original (charge.ts usa console.error + return).
 */
export async function insertUsageRecord(
  record: UsageRecordInsert,
): Promise<{ id: string } | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("usage_records")
    .insert(record)
    .select("id")
    .single();
  if (error) {
    console.error("[usage-records.repo] insertUsageRecord failed:", error.message);
    return null;
  }
  return data;
}

/**
 * Atualiza um usage_record por id (update parcial).
 * Usado após charge bem-sucedida para marcar charged_to_wallet=true.
 */
export async function updateUsageRecord(
  recordId: string,
  patch: Partial<UsageRecordRow>,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("usage_records")
    .update(patch)
    .eq("id", recordId);
}

/**
 * Marca um record como cobrado por BYO key (custom key — skip wallet).
 * Replica o UPDATE de billing/charge.ts quando usesCustomKey=true.
 */
export async function markCustomKeyCharged(recordId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("usage_records")
    .update({ charged_to_wallet: true })
    .eq("id", recordId);
}

/**
 * Marca um record como cap_blocked (cap mensal atingido).
 */
export async function markCapBlocked(recordId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("usage_records")
    .update({ cap_blocked: true })
    .eq("id", recordId);
}
