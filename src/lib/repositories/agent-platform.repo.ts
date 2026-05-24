/**
 * Repositório da Plataforma Modular de Agentes (Fase 0).
 *
 * Acesso a entitlements, templates, módulos e composição (module instances).
 * Tudo via service role (createAdminClient) — RLS nega anon (migration 00075).
 *
 * Schema: 00075. Tipos: @/types/agent-platform. Plano: _planning/plataforma-modular/PLANO.md.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type {
  AgentTemplate,
  AgentModule,
  AgentModuleInstance,
  AgentEntitlement,
  AgentCapability,
} from "@/types/agent-platform";

// =====================================================================
// Entitlements
// =====================================================================

/**
 * Retorna o entitlement ATIVO de (location, capability), ou null.
 * Considera expiração: se `expires_at` já passou, trata como inexistente.
 */
export async function getActiveEntitlement(
  locationId: string,
  capability: AgentCapability,
): Promise<AgentEntitlement | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_entitlements")
    .select("*")
    .eq("location_id", locationId)
    .eq("capability", capability)
    .eq("status", "active")
    .maybeSingle();
  if (error || !data) return null;
  const ent = data as AgentEntitlement;
  // Expiração: trata expirado como sem acesso (não muta o DB aqui; cleanup é
  // responsabilidade de um job/admin — manter a leitura barata e idempotente).
  if (ent.expires_at && new Date(ent.expires_at).getTime() < Date.now()) {
    return null;
  }
  return ent;
}

/** Lista todos os entitlements de uma location (ativos e revogados). */
export async function listEntitlements(locationId: string): Promise<AgentEntitlement[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_entitlements")
    .select("*")
    .eq("location_id", locationId)
    .order("granted_at", { ascending: false });
  return (data as AgentEntitlement[] | null) || [];
}

/**
 * Libera (ou re-libera) uma capacidade pra uma location. Idempotente: se já
 * existe um ativo, atualiza; senão cria. `expiresAt` opcional (agente temporário
 * / trial). Liberação MANUAL (D6) — `grantedBy` identifica quem liberou.
 */
export async function grantEntitlement(params: {
  locationId: string;
  capability: AgentCapability;
  grantedBy: string;
  source?: "manual" | "purchase";
  expiresAt?: string | null;
  notes?: string | null;
}): Promise<AgentEntitlement> {
  const supabase = createAdminClient();
  const existing = await getActiveEntitlement(params.locationId, params.capability);
  const nowIso = new Date().toISOString();

  if (existing) {
    const { data, error } = await supabase
      .from("agent_entitlements")
      .update({
        source: params.source ?? existing.source,
        granted_by: params.grantedBy,
        granted_at: nowIso,
        expires_at: params.expiresAt ?? null,
        notes: params.notes ?? existing.notes,
        updated_at: nowIso,
      })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw new Error(`grantEntitlement update falhou: ${error.message}`);
    return data as AgentEntitlement;
  }

  const { data, error } = await supabase
    .from("agent_entitlements")
    .insert({
      location_id: params.locationId,
      capability: params.capability,
      status: "active",
      source: params.source ?? "manual",
      granted_by: params.grantedBy,
      expires_at: params.expiresAt ?? null,
      notes: params.notes ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`grantEntitlement insert falhou: ${error.message}`);
  return data as AgentEntitlement;
}

/** Revoga o entitlement ativo de (location, capability). No-op se não houver. */
export async function revokeEntitlement(
  locationId: string,
  capability: AgentCapability,
  revokedBy: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("agent_entitlements")
    .update({ status: "revoked", revoked_at: nowIso, granted_by: revokedBy, updated_at: nowIso })
    .eq("location_id", locationId)
    .eq("capability", capability)
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(`revokeEntitlement falhou: ${error.message}`);
  return (data?.length || 0) > 0;
}

// =====================================================================
// Templates & Módulos (catálogo)
// =====================================================================

export async function listTemplates(opts?: { audience?: "rep" | "lead" }): Promise<AgentTemplate[]> {
  const supabase = createAdminClient();
  let q = supabase.from("agent_templates").select("*").eq("status", "active").order("key");
  if (opts?.audience) q = q.eq("audience", opts.audience);
  const { data } = await q;
  return (data as AgentTemplate[] | null) || [];
}

export async function getTemplate(key: string): Promise<AgentTemplate | null> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("agent_templates").select("*").eq("key", key).maybeSingle();
  return (data as AgentTemplate | null) || null;
}

/** Lista o catálogo de módulos ativos (última versão por key vem do registry/DB). */
export async function listModules(): Promise<AgentModule[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_modules")
    .select("*")
    .eq("status", "active")
    .order("category");
  return (data as AgentModule[] | null) || [];
}

// =====================================================================
// Composição por agente
// =====================================================================

/** Módulos ligados de um agente, em ordem (sort_order asc). */
export async function getAgentModuleInstances(agentId: string): Promise<AgentModuleInstance[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_module_instances")
    .select("*")
    .eq("agent_id", agentId)
    .eq("enabled", true)
    .order("sort_order", { ascending: true });
  return (data as AgentModuleInstance[] | null) || [];
}
