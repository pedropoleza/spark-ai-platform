/**
 * Types compartilhados do domínio follow-up (Pedro 2026-05-18).
 *
 * Plano: _planning/followup-feature.md
 * Schema: supabase/migrations/00067_followup_feature.sql
 */

export type FollowupSource = "chat" | "proactive_rule" | "webhook";

export type SequenceType =
  | "sales"
  | "service"
  | "reschedule"
  | "pos_sale"
  | "internal_reminder"
  | "recurring"
  | "custom";

export type SpamRisk = "low" | "medium" | "high";

export type ContextSource = "manual_only" | "conversation_used" | "mixed" | "none";

export type ApprovalStatus =
  | "pending_approval"
  | "approved"
  | "auto_approved"
  | "edited"
  | "rejected";

export type SequenceStatus =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "skipped_reply"
  | "skipped_dnd"
  | "skipped_optout"
  | "failed";

export type MessageStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "cancelled";

export type ApprovalMode =
  | "adaptive"
  | "always_ask"
  | "auto_low_risk"
  | "auto_all";

/**
 * Entrada única pro core service. Chat, proactive_rule e webhook futuro
 * todos chamam createFollowupRequest com essa estrutura.
 */
export interface FollowupInput {
  source: FollowupSource;
  rep_id: string;
  location_id: string;
  agent_id: string | null;

  // Contato (uma das duas formas)
  contact_id?: string;
  contact_query?: string;     // nome/phone pra resolver

  // Goal + contexto
  goal?: string;
  manual_context?: string;
  use_conversation_context?: boolean;  // undefined = bot vai perguntar
  sequence_type?: SequenceType;
  tone?: string;

  // Schedule
  requested_at?: string;       // ISO ou texto natural
  sequence_length?: number;    // 1-3
  delivery_channel?: string;

  // Modular: source-specific data (proactive rule passa pipeline_id, etc)
  source_metadata?: Record<string, unknown>;
}

/**
 * Resultado retornado pelo core. Tools mapeiam isso pra texto que LLM apresenta.
 */
export interface FollowupResult {
  ok: boolean;

  // Caso de erro logo no início (contato não achado, multi, etc)
  error?: {
    kind:
      | "contact_not_found"
      | "contact_ambiguous"
      | "wallet_blocked"
      | "feature_disabled"
      | "duplicate_active_sequence"
      | "opt_out"
      | "internal";
    message: string;
    candidates?: Array<{ id: string; name: string; phone?: string; last_activity?: string }>;
  };

  // Caso bot precisa perguntar algo (use_conversation_context indefinido, etc)
  needs_user_decision?: {
    kind: "use_conversation_context" | "pick_contact" | "pick_date";
    prompt: string;
    options?: string[];
  };

  // Sequence criada — você sempre tem isso quando ok=true e sem error
  sequence_id?: string;

  // Decisão do flow
  flow_decision?: "auto_scheduled" | "approval_required" | "blocked_high_risk" | "internal_reminder_only";

  spam_score?: number;
  spam_risk?: SpamRisk;
  spam_flags?: string[];
  spam_recommendation?: string;

  // Preview pra LLM apresentar pro rep
  messages_preview?: Array<{
    position: number;
    text: string;
    scheduled_at: string;
    scheduled_at_human?: string;
  }>;

  // Texto recomendado pro LLM "como" apresentar (não obrigatório usar)
  ai_presentation_hint?: string;
}

/**
 * Resultado do cálculo de spam score.
 */
export interface SpamScoreResult {
  score: number;       // 0-100
  risk: SpamRisk;
  flags: string[];     // strings curtas pro rep ler
  recommendation: "auto_schedule" | "request_approval" | "internal_reminder_only";
  max_suggested_messages: number;
  rationale?: string;  // breve explicação (se LLM ajustou)
  used_llm_refinement: boolean;
}

/**
 * Resultado do summarizer de conversa.
 */
export interface ConversationSummary {
  has_conversation: boolean;
  message_count: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  unanswered_outbound_count: number;
  inbound_outbound_ratio: number;
  summary: string;     // resumo LLM 1-2 parágrafos
  flags?: string[];    // \"contato pediu mais tempo\", etc
}

/**
 * Configurações do follow-up por agent.
 */
export interface FollowupSettings {
  feature_enabled: boolean;
  approval_mode: ApprovalMode;
  default_sequence_length: number;
  max_sequence_length: number;
  default_interval_hours: number;
  max_messages_without_response: number;
  allow_conversation_context: boolean;
  allowed_channels: string[];
  stage_triggers: Record<string, unknown> | null;
}

/**
 * Mensagem gerada pelo LLM (pré-persist).
 */
export interface DraftMessage {
  position: number;
  text: string;
  tone_hint?: string;
  offset_hours_from_first: number;  // 0 pra primeira, 48 pra segunda, etc
}

/**
 * Resultado da geração de sequence.
 */
export interface GeneratedSequence {
  messages: DraftMessage[];
  inferred_goal?: string;
  inferred_tone?: string;
  rationale?: string;
}

/**
 * Snapshot completo de uma sequence (pra dashboard / list tool).
 */
export interface SequenceSnapshot {
  sequence_id: string;
  rep_id: string;
  location_id: string;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  goal: string | null;
  sequence_type: SequenceType;
  status: SequenceStatus;
  approval_status: ApprovalStatus;
  spam_risk: SpamRisk | null;
  spam_score: number | null;
  total_messages: number;
  sent_messages: number;
  failed_messages: number;
  skipped_messages: number;
  scheduled_first_at: string | null;
  scheduled_last_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  source: FollowupSource;
}

export interface MessageSnapshot {
  id: string;
  position: number;
  text: string;
  scheduled_at: string;
  status: MessageStatus;
  sent_at: string | null;
  error_message: string | null;
}
