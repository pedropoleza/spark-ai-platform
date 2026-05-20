/**
 * Repositório para as tabelas `agents` e `agent_configs`.
 *
 * Encapsula o nome das tabelas e das colunas. Cada função replica EXATAMENTE
 * a query do call site original — sem adicionar lógica de negócio.
 *
 * Cobertura atual: queries de leitura de agents e agent_configs que ocorrem
 * nos arquivos menos críticos (proativos, tools, rotas de configuração).
 *
 * ⚠️ NÃO migrar as queries de webhook-handler.ts (agents + agent_configs)
 * por estarem no hot path de ingestão junto com a lógica de whitelist e
 * configuração de turn — qualquer refatoração ali requer revisão manual.
 */

import { createAdminClient } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Tipos auxiliares
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  location_id: string;
  type: string;
  status: string;
  company_id?: string | null;
  name?: string | null;
  [key: string]: unknown;
}

export interface AgentConfigRow {
  agent_id: string;
  monthly_spend_cap_usd?: number | null;
  confirmation_mode?: string | null;
  ai_model?: string | null;
  fallback_model?: string | null;
  custom_instructions?: string | null;
  knowledge_base_instructions?: string | null;
  disabled_tools?: unknown;
  enabled_kbs?: unknown;
  tone_creativity?: number | null;
  tone_formality?: number | null;
  tone_naturalness?: number | null;
  tone_aggressiveness?: number | null;
  enable_audio_transcription?: boolean | null;
  enable_image_analysis?: boolean | null;
  enable_pdf_reading?: boolean | null;
  allowed_ghl_users?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// agents — Leitura
// ---------------------------------------------------------------------------

/**
 * Busca o agent Sparkbot ativo de uma location.
 * Query: SELECT id FROM agents WHERE location_id=? AND type='account_assistant'
 * AND status='active'.
 *
 * Usado em reminder-runner, whatsapp-delivery, e outros proativos.
 */
export async function findActiveSparkbotAgent(
  locationId: string,
): Promise<{ id: string } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", locationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  return data ?? null;
}

/**
 * Busca agent completo por id (todos os campos).
 */
export async function findAgentById(agentId: string): Promise<AgentRow | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .maybeSingle();
  return (data as AgentRow | null) ?? null;
}

/**
 * Busca agent por location_id (todos os campos).
 */
export async function findAgentByLocationId(
  locationId: string,
): Promise<AgentRow | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agents")
    .select("*")
    .eq("location_id", locationId)
    .maybeSingle();
  return (data as AgentRow | null) ?? null;
}

/**
 * Busca todos os agents ativos de tipo account_assistant.
 * Usado por hub-resolver para resolver hubs ativos.
 */
export async function findAllActiveSparkbotAgents(): Promise<
  Array<{ id: string; location_id: string }>
> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agents")
    .select("id, location_id")
    .eq("type", "account_assistant")
    .eq("status", "active");
  if (error) {
    console.warn("[agents.repo] findAllActiveSparkbotAgents failed:", error.message);
    return [];
  }
  return (data ?? []) as Array<{ id: string; location_id: string }>;
}

/**
 * Verifica se uma location tem agent Sparkbot ativo (isSparkbotHub check).
 * Retorna apenas boolean para uso no multi-tenant router.
 */
export async function isSparkbotHubLocation(locationId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", locationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  return data !== null;
}

// ---------------------------------------------------------------------------
// agent_configs — Leitura
// ---------------------------------------------------------------------------

/**
 * Busca a config completa de um agent.
 */
export async function findAgentConfig(
  agentId: string,
): Promise<AgentConfigRow | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_configs")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle();
  return (data as AgentConfigRow | null) ?? null;
}

/**
 * Busca apenas o monthly_spend_cap_usd de um agent.
 * Usado por billing/charge.ts:isMonthlyCapReached.
 */
export async function getMonthlySpendCap(
  agentId: string,
): Promise<{ monthly_spend_cap_usd: number | null } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_configs")
    .select("monthly_spend_cap_usd")
    .eq("agent_id", agentId)
    .maybeSingle();
  return data ?? null;
}

// ---------------------------------------------------------------------------
// agents — Escrita
// ---------------------------------------------------------------------------

/**
 * Atualiza campos de um agent por id.
 */
export async function updateAgentById(
  agentId: string,
  patch: Partial<AgentRow>,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("agents")
    .update(patch)
    .eq("id", agentId);
}

// ---------------------------------------------------------------------------
// agent_configs — Escrita
// ---------------------------------------------------------------------------

/**
 * Atualiza config de um agent (upsert por agent_id).
 */
export async function upsertAgentConfig(
  agentId: string,
  patch: Partial<AgentConfigRow>,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("agent_configs")
    .update(patch)
    .eq("agent_id", agentId);
}
