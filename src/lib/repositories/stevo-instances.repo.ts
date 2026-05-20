/**
 * Repositório da tabela `stevo_instances` — config da instância Stevo por Hub
 * (serverUrl + instanceToken). Auto-mantida a cada inbound do Stevo (upsert no
 * stevo-handler) e lida pelos PROATIVOS (deliverProactiveMessage) pra enviar
 * via Stevo quando não há inbound de onde puxar o serverUrl+token.
 *
 * Pedro 2026-05-20: parte da transferência COMPLETA do canal do rep pro Stevo
 * (novo padrão; GHL fallback). Migration 00072.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface StevoInstanceConfig {
  hubLocationId: string;
  serverUrl: string;
  instanceToken: string;
  instanceName?: string | null;
}

export interface StevoInstanceResolved {
  serverUrl: string;
  instanceToken: string;
  instanceName: string | null;
}

/**
 * Upsert da config da instância por hub. Não lança — loga e segue (chamado em
 * background no hot path do webhook). Omite instance_id de propósito (não é
 * usado pra envio; o seed já preserva quando existe).
 */
export async function upsertStevoInstance(cfg: StevoInstanceConfig): Promise<void> {
  if (!cfg.hubLocationId || !cfg.serverUrl || !cfg.instanceToken) return;
  const db = createAdminClient();
  const { error } = await db.from("stevo_instances").upsert(
    {
      hub_location_id: cfg.hubLocationId,
      server_url: cfg.serverUrl,
      instance_token: cfg.instanceToken,
      instance_name: cfg.instanceName ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "hub_location_id" },
  );
  if (error) {
    console.warn(
      `[stevo-instances.repo] upsert falhou (hub ${cfg.hubLocationId}):`,
      error.message,
    );
  }
}

/**
 * Resolve a config da instância Stevo de um hub. Retorna null se não houver
 * registro ou faltarem campos essenciais (caller cai no fallback GHL).
 */
export async function getStevoInstance(
  hubLocationId: string,
): Promise<StevoInstanceResolved | null> {
  if (!hubLocationId) return null;
  const db = createAdminClient();
  const { data, error } = await db
    .from("stevo_instances")
    .select("server_url, instance_token, instance_name")
    .eq("hub_location_id", hubLocationId)
    .maybeSingle();
  if (error || !data || !data.server_url || !data.instance_token) return null;
  return {
    serverUrl: data.server_url,
    instanceToken: data.instance_token,
    instanceName: data.instance_name ?? null,
  };
}
