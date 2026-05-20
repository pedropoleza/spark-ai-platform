/**
 * Repositório para a tabela `sparkbot_messages`.
 *
 * Encapsula o nome da tabela e das colunas — chamadores não precisam
 * hardcodar strings. Cada função replica EXATAMENTE a query do call site
 * original; nenhuma lógica de negócio foi adicionada ou removida.
 *
 * ⚠️ NÃO migrar para este repo os call sites de webhook-handler.ts que
 * envolvem dedup/idempotência (content-match, timing-match, INSERT do user
 * msg com captura de 23505, etc.) — essas queries estão entrelaçadas com
 * as 7 camadas de idempotência e qualquer abstração pode romper a cadeia.
 * Listadas em "call sites NÃO migrados" no B1-arquitetura.md §3.
 */

import { createAdminClient } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Tipos auxiliares
// ---------------------------------------------------------------------------

export interface SparkbotMessageInsert {
  rep_id: string;
  hub_location_id: string;
  agent_id: string;
  active_location_id?: string | null;
  role: "user" | "agent" | "system";
  content: string;
  channel?: string;
  ghl_message_id?: string | null;
  read_in_web_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SparkbotMessageRow {
  id: string;
  rep_id: string;
  hub_location_id: string;
  agent_id: string | null;
  active_location_id: string | null;
  role: string;
  content: string;
  channel: string | null;
  ghl_message_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Busca o histórico recente do rep para construir conversationHistory.
 * Retorna os últimos `limit` turns em ordem DESC (mais recente primeiro).
 * Caller deve reverter se precisar de ordem cronológica.
 */
export async function getSparkbotHistory(
  repId: string,
  hubLocationId: string,
  limit: number,
): Promise<Array<{ role: string; content: string; created_at: string }>> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("sparkbot_messages")
    .select("role, content, created_at")
    .eq("rep_id", repId)
    .eq("hub_location_id", hubLocationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[sparkbot-messages.repo] getSparkbotHistory failed:", error.message);
  }
  return data ?? [];
}

/**
 * Busca 1 mensagem por ghl_message_id (para dedup SELECT upfront).
 * Retorna apenas o `id` — caller só precisa saber se existe.
 *
 * Nota: este SELECT simples por ghl_message_id é SEGURO migrar (não está
 * entrelaçado com race conditions). Os SELECTs de content-match e
 * timing-match em webhook-handler.ts NÃO foram migrados aqui.
 */
export async function findByGhlMessageId(
  ghlMessageId: string,
): Promise<{ id: string } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("sparkbot_messages")
    .select("id")
    .eq("ghl_message_id", ghlMessageId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Busca última mensagem do agente para um contato (usado no recency check
 * de REACTION em webhook-handler).
 *
 * Nota: este SELECT também está no webhook-handler no bloco de REACTION
 * — NÃO migrado pois está dentro de try/catch crítico do fluxo de
 * idempotência. Esta versão exportada serve apenas para outros callers.
 */
export async function findLastAgentMessageForContact(
  hubLocationId: string,
  contactId: string,
  cutoffIso: string,
): Promise<{ id: string; created_at: string } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("sparkbot_messages")
    .select("id, created_at")
    .eq("hub_location_id", hubLocationId)
    .eq("role", "agent")
    .filter("metadata->>ghl_contact_id", "eq", contactId)
    .gte("created_at", cutoffIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * Busca o hub_location_id da última mensagem inbound de um rep.
 * Usado por reminder-runner e outros proativos.
 */
export async function findLastInboundHubLocation(
  repId: string,
): Promise<string | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("sparkbot_messages")
    .select("hub_location_id")
    .eq("rep_id", repId)
    .eq("role", "user")
    .not("hub_location_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.hub_location_id as string | null | undefined) ?? null;
}

/**
 * Busca mensagens recentes de um rep para análise de silence gap.
 * Filtra por active_location_id — usado em processor.ts.
 */
export async function getRecentMessagesForSilenceCheck(
  repId: string,
  activeLocationId: string,
  limit: number,
): Promise<Array<{ role: string; content: string; created_at: string }>> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("sparkbot_messages")
    .select("role, content, created_at")
    .eq("rep_identity_id", repId)
    .eq("active_location_id", activeLocationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

/**
 * Busca mensagens recentes para o inbox web UI (paginação).
 */
export async function getInboxMessages(
  repId: string,
  hubLocationId: string,
  limit: number,
  offset: number,
): Promise<SparkbotMessageRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("sparkbot_messages")
    .select("*")
    .eq("rep_id", repId)
    .eq("hub_location_id", hubLocationId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  return (data ?? []) as SparkbotMessageRow[];
}

/**
 * Count de mensagens por role para dashboard admin (últimas 24h).
 */
export async function countMessagesByRole(
  cutoffIso: string,
): Promise<{ count: number | null }> {
  const supabase = createAdminClient();
  const { count } = await supabase
    .from("sparkbot_messages")
    .select("role", { count: "exact" })
    .gte("created_at", cutoffIso);
  return { count: count ?? null };
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/**
 * Insere uma mensagem no sparkbot_messages.
 * Retorna o erro caso ocorra (sem throw) — caller decide o que fazer.
 *
 * ⚠️ O INSERT do webhook-handler (user msg com captura 23505) NÃO usa esta
 * função — está hardcoded propositalmente por ser camada de idempotência.
 */
export async function insertSparkbotMessage(
  msg: SparkbotMessageInsert,
): Promise<{ id: string } | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("sparkbot_messages")
    .insert(msg)
    .select("id")
    .single();
  if (error) {
    console.warn("[sparkbot-messages.repo] insertSparkbotMessage failed:", error.message);
    return null;
  }
  return data;
}

/**
 * Insere mensagem de onboarding no sparkbot_messages (web UI path).
 * Usado por onboarding.ts:seedWebOnboardingMessage — retorna o id ou null.
 */
export async function insertOnboardingMessage(
  msg: SparkbotMessageInsert & { read_in_web_at: string },
): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("sparkbot_messages")
    .insert(msg)
    .select("id")
    .single();
  if (error) {
    console.warn("[sparkbot-messages.repo] insertOnboardingMessage failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}
