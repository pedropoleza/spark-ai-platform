/**
 * Tipos do Account Assistant (Sparkbot).
 *
 * Diferente de sales/recruitment agents (que conversam com LEADS), o Account
 * Assistant conversa com o REP comercial humano via WhatsApp dedicado e opera
 * o GHL em nome dele. Não confunde com AgentConfig dos outros agentes — ele
 * reusa agent_configs mas adiciona colunas específicas.
 */

/** Link entre um rep (por phone) e suas identidades GHL em N locations. */
export interface GHLUserLink {
  location_id: string;
  ghl_user_id: string;
  location_name: string | null;
  role: string | null;
}

/** Perfil adaptativo — o que o Sparkbot aprende sobre o rep ao longo do tempo. */
export interface RepProfile {
  preferences?: {
    tone?: "casual" | "formal";
    response_style?: "brief" | "detailed";
    emoji_usage?: "none" | "occasional";
  };
  habits?: {
    active_hours?: string[];       // ex: ["08:00-12:00", "14:00-18:00"]
    prefers_morning?: boolean;
    typical_follow_up_window?: string; // ex: "24h"
  };
  relationships?: {
    vip_contacts?: string[];       // ghl contact IDs
    difficult_contacts?: string[];
  };
  opt_outs?: {
    weekend_alerts?: boolean;
    pre_meeting_briefing?: boolean;
  };
  notes?: string[];                // free-form observações
}

export interface RepIdentity {
  id: string;
  phone: string;
  display_name: string | null;
  ghl_users: GHLUserLink[];
  active_location_id: string | null;
  profile: RepProfile;
  terms_accepted_at: string | null;
  unanswered_count: number;
  unanswered_pause_until: string | null;
  created_at: string;
  updated_at: string;
}

/** Estado pendente de uma sessão — aguardando input do rep. */
export type PendingAction =
  | {
      type: "confirm_action";
      tool: string;
      args: Record<string, unknown>;
      summary: string;            // o que vai acontecer em linguagem natural
      risk: "medium" | "high";
      expires_at: string;
    }
  | {
      type: "clarify_entity";
      entity_type: "contact" | "opportunity" | "appointment";
      original_query: string;
      tool_pending: string;       // qual tool refazer após clarificação
      args_pending: Record<string, unknown>;
      candidates: Array<{
        id: string;
        label: string;            // "João Silva — última conv 2d, Negotiation R$5k"
        metadata?: Record<string, unknown>;
      }>;
      expires_at: string;
    }
  | {
      type: "choose_location";
      options: Array<{ location_id: string; location_name: string }>;
      expires_at: string;
    }
  | {
      type: "awaiting_terms_acceptance";
      sent_at: string;
    };

export interface AssistantConversation {
  id: string;
  rep_id: string;
  ghl_conversation_id: string | null;
  pending_action: PendingAction | null;
  pending_messages: string[];
  debounce_expires_at: string | null;
  last_turn_at: string | null;
  turn_count: number;
  ai_paused_at: string | null;
  ai_paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Input multimodal que o rep pode enviar. */
export type RepInput =
  | { kind: "text"; text: string }
  | { kind: "audio"; transcribed_text: string; original_url?: string }
  | { kind: "image"; base64_data_uri: string; caption?: string }
  | { kind: "document"; extracted_text: string; filename: string };

/** Tool do catálogo V1. */
export interface ToolDefinition {
  name: string;
  description: string;
  risk: "safe" | "medium" | "high";
  // JSON Schema dos args (formato OpenAI/Claude tools API)
  parameters: Record<string, unknown>;
}

/** Resultado da execução de uma tool. */
export type ToolResult =
  | { status: "ok"; data: unknown }
  | {
      status: "ambiguous";
      entity_type: "contact" | "opportunity" | "appointment";
      original_query: string;
      candidates: Array<{ id: string; label: string; metadata?: Record<string, unknown> }>;
    }
  | { status: "not_found"; message: string }
  | { status: "error"; message: string; retryable: boolean };

/** Config do Account Assistant (extensão da AgentConfig). */
export interface AssistantWhitelistEntry {
  ghl_user_id: string;
  name: string;
  phone: string;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;          // "22:00"
  end: string;            // "07:00"
  timezone: string;       // "America/New_York"
  days: number[];         // 0=dom..6=sab
}

export interface AccountAssistantConfigExtras {
  allowed_ghl_users: AssistantWhitelistEntry[];
  confirmation_mode: "always" | "medium_and_high" | "high_only";
  no_response_threshold: number;
  quiet_hours: QuietHoursConfig | Record<string, never>;
  alert_toggles: Record<string, boolean>; // placeholder V2
}
