/**
 * Tipos da Plataforma Modular de Agentes (Fase 0, Pedro 2026-05-24).
 *
 * Eixo central: rep-facing (SparkBot, incluso) × lead-facing (venda/recrut/
 * custom, pago). Agentes = template + módulos compostos sobre um motor único.
 * Schema: migration 00075. Desenho: _planning/plataforma-modular/PLANO.md.
 */

/** rep-facing (fala com o user/rep) vs lead-facing (fala com leads/contatos). */
export type AgentAudience = "rep" | "lead";

/** Categorias do catálogo de módulos (D8). Extensível. */
export type ModuleCategory =
  | "behavior" // comportamento e naturalidade
  | "active_hours" // janela de tempo / horários ativos
  | "followup" // follow-up automático
  | "qualification" // coleta de data fields (lead)
  | "scheduling" // agendamento
  | "compliance" // anti-spam / opt-out (lead-facing)
  | "channel" // WhatsApp / IG DM / ...
  | "crm_ops" // notes / tasks / tags / opps
  | "knowledge"; // base de conhecimento (carrier/empresa)

/** Escopo de audiência de um módulo. */
export type ModuleAudienceScope = "rep" | "lead" | "both";

/**
 * Capacidade paga liberável por location (entitlement). SparkBot
 * (account_assistant) é incluso e NÃO precisa de entitlement.
 */
export type AgentCapability = "sales_agent" | "recruitment_agent" | "custom_agent";

export type EntitlementStatus = "active" | "revoked";
export type EntitlementSource = "manual" | "purchase";
export type LifecycleStatus = "active" | "draft" | "archived";

/** Template = base curada pela agência. Venda/recrut viram templates seed. */
export interface AgentTemplate {
  id: string;
  key: string; // 'sparkbot' | 'sales' | 'recruitment' | custom...
  name: string;
  audience: AgentAudience;
  description: string | null;
  version: number;
  base_config: Record<string, unknown>;
  default_modules: string[]; // module keys
  is_seed: boolean;
  status: LifecycleStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Módulo do catálogo. `prompt_fragment` NULL = o registry TS provê o fragmento
 * por `key` (Fase 1). DB pode sobrescrever o fragmento sem deploy.
 */
export interface AgentModule {
  id: string;
  key: string;
  name: string;
  category: ModuleCategory;
  version: number;
  audience_scope: ModuleAudienceScope;
  prompt_fragment: string | null;
  allowed_tools: string[];
  settings_schema: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  status: LifecycleStatus;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

/** Composição: qual módulo um agente liga + settings + override + ordem. */
export interface AgentModuleInstance {
  id: string;
  agent_id: string;
  module_key: string;
  module_version: number;
  enabled: boolean;
  settings: Record<string, unknown>;
  prompt_override: string | null; // override livre por agente (D9 — não-limitar)
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Entitlement: capacidade paga liberada pra uma location. */
export interface AgentEntitlement {
  id: string;
  location_id: string;
  capability: AgentCapability;
  status: EntitlementStatus;
  source: EntitlementSource;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
