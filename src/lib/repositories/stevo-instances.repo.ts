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

// ---------------------------------------------------------------------------
// Gate de instância DEDICADA (group campaigns, Pedro 2026-06-18)
// ---------------------------------------------------------------------------

/**
 * Resultado discriminado da resolução de instância pra CAMPANHA DE GRUPO. O
 * gate anti-ban (risco sistêmico) exige instância `kind='dedicated'`: campanha de
 * grupo NUNCA roda sobre o número compartilhado que carrega o DM de todos os reps
 * (um ban derrubaria todo mundo). Os motivos de recusa permitem ao SparkBot dar o
 * nudge certo (servidor dedicado) em vez de um erro seco.
 */
export type DedicatedStevoResult =
  | { ok: true; instance: StevoInstanceResolved }
  | { ok: false; reason: "no_instance" | "shared_only" | "misconfigured"; instanceName: string | null };

/**
 * Resolve a instância Stevo de uma LOCATION (não do hub) APENAS se ela for
 * dedicada. Usada pelo gate de campanha em grupo. Diferente de getStevoInstance:
 * (a) lê a coluna `kind`; (b) recusa explicitamente a compartilhada (com motivo);
 * (c) não cai em fallback GHL (grupo não tem rota GHL).
 *
 * ⚠️ CHAVE: usa `hub_location_id` (nome legado da PK; uma row por location). O
 * caller passa a `active_location_id` do rep (ctx.locationId). A row DEDICADA tem
 * que ser provisionada com `hub_location_id = <active_location_id do rep>` — não
 * a da agência/hub. Em rep multi-location, a instância dedicada só casa com a
 * location ATIVA no momento. (Provisionamento manual segue esse contrato.)
 *
 * - sem registro pra essa location → { ok:false, reason:'no_instance' }
 * - registro com kind != 'dedicated' → { ok:false, reason:'shared_only' }
 * - kind='dedicated' mas SEM creds (server_url/token) → { ok:false, reason:'misconfigured' }
 * - dedicada com creds → { ok:true, instance }
 */
export async function getStevoInstanceForRep(
  locationId: string,
): Promise<DedicatedStevoResult> {
  if (!locationId) return { ok: false, reason: "no_instance", instanceName: null };
  const db = createAdminClient();
  const { data, error } = await db
    .from("stevo_instances")
    .select("server_url, instance_token, instance_name, kind")
    .eq("hub_location_id", locationId)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "no_instance", instanceName: null };
  const instanceName = data.instance_name ?? null;
  if (data.kind !== "dedicated") {
    return { ok: false, reason: "shared_only", instanceName };
  }
  // Dedicada porém sem credenciais = problema de provisionamento (não é "compre
  // um servidor" — ele já tem um, só está mal configurado).
  if (!data.server_url || !data.instance_token) {
    return { ok: false, reason: "misconfigured", instanceName };
  }
  return {
    ok: true,
    instance: {
      serverUrl: data.server_url,
      instanceToken: data.instance_token,
      instanceName,
    },
  };
}
