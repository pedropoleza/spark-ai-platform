import { createAdminClient } from "@/lib/supabase/admin";
import { getLocationToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";
import { calculateCost } from "./pricing";

interface TrackUsageParams {
  locationId: string;
  companyId: string;
  agentId: string;
  contactId?: string;
  actionType: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usesCustomKey: boolean;
}

/**
 * Registra uso e cobra do wallet do GHL (se nao usa chave propria)
 */
export async function trackAndCharge(params: TrackUsageParams): Promise<void> {
  const supabase = createAdminClient();
  const cost = calculateCost(params.model, params.promptTokens, params.completionTokens);

  // Registrar uso
  const { data: record } = await supabase
    .from("usage_records")
    .insert({
      location_id: params.locationId,
      agent_id: params.agentId,
      contact_id: params.contactId || null,
      action_type: params.actionType,
      ai_model: cost.model,
      prompt_tokens: cost.promptTokens,
      completion_tokens: cost.completionTokens,
      total_tokens: cost.totalTokens,
      cost_usd: cost.costUsd,
      markup_usd: cost.markupUsd,
      total_charge_usd: cost.totalChargeUsd,
      uses_custom_key: params.usesCustomKey,
      charged_to_wallet: false,
    })
    .select("id")
    .single();

  // Se usa chave propria, nao cobra
  if (params.usesCustomKey) {
    if (record) {
      await supabase
        .from("usage_records")
        .update({ charged_to_wallet: true })
        .eq("id", record.id);
    }
    return;
  }

  // Cobrar do wallet via GHL Marketplace API
  if (cost.totalChargeUsd > 0 && record) {
    try {
      await chargeWallet(params.companyId, params.locationId, cost.totalChargeUsd, params.actionType);

      await supabase
        .from("usage_records")
        .update({ charged_to_wallet: true })
        .eq("id", record.id);
    } catch (error) {
      console.error("[Billing] Failed to charge wallet:", error);
      // Nao bloqueia o processamento — a cobranca pode ser retentada depois
    }
  }
}

/**
 * Cobra do wallet da sub-account via GHL Marketplace API
 */
async function chargeWallet(
  companyId: string,
  locationId: string,
  amountUsd: number,
  description: string
): Promise<void> {
  const token = await getLocationToken(companyId, locationId);

  // Converter para centavos (GHL pode esperar em centavos)
  const amountCents = Math.ceil(amountUsd * 100);

  const response = await fetch(`${GHL_API_BASE}/marketplace/billing/charges`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({
      locationId,
      amount: amountCents,
      description: `Spark AI - ${formatDescription(description)}`,
      currency: "USD",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GHL billing charge failed: ${response.status} - ${errorBody}`);
  }
}

function formatDescription(actionType: string): string {
  const map: Record<string, string> = {
    ai_processing: "Processamento de mensagem IA",
    follow_up: "Follow-up automatico",
    send_message: "Envio de mensagem",
  };
  return map[actionType] || actionType;
}

/**
 * Verificar se a sub-account tem saldo suficiente
 */
export async function checkWalletBalance(
  companyId: string,
  locationId: string
): Promise<boolean> {
  try {
    const token = await getLocationToken(companyId, locationId);

    const response = await fetch(`${GHL_API_BASE}/marketplace/billing/charges`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
      },
    });

    if (!response.ok) return true; // Em caso de erro, permitir (fail open para nao bloquear)

    return true;
  } catch {
    return true; // Fail open
  }
}

/**
 * Cobra registros pendentes que falharam anteriormente
 */
export async function chargeUnbilledRecords(): Promise<{ charged: number; failed: number }> {
  const supabase = createAdminClient();
  let charged = 0;
  let failed = 0;

  const { data: pending } = await supabase
    .from("usage_records")
    .select("*")
    .eq("charged_to_wallet", false)
    .eq("uses_custom_key", false)
    .gt("total_charge_usd", 0)
    .order("created_at", { ascending: true })
    .limit(50);

  if (!pending || pending.length === 0) return { charged: 0, failed: 0 };

  // Agrupar por location para cobrar em batch
  const byLocation = new Map<string, { totalUsd: number; ids: string[] }>();

  for (const record of pending) {
    const key = record.location_id;
    if (!byLocation.has(key)) {
      byLocation.set(key, { totalUsd: 0, ids: [] });
    }
    const group = byLocation.get(key)!;
    group.totalUsd += Number(record.total_charge_usd);
    group.ids.push(record.id);
  }

  for (const [locationId, group] of Array.from(byLocation.entries())) {
    try {
      const { data: location } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", locationId)
        .single();

      if (!location) {
        failed += group.ids.length;
        continue;
      }

      await chargeWallet(
        location.company_id,
        locationId,
        group.totalUsd,
        `Batch: ${group.ids.length} interacoes`
      );

      await supabase
        .from("usage_records")
        .update({ charged_to_wallet: true })
        .in("id", group.ids);

      charged += group.ids.length;
    } catch {
      failed += group.ids.length;
    }
  }

  return { charged, failed };
}
