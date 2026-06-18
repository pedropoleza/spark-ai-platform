export type AgentType = "sales_agent" | "recruitment_agent" | "account_assistant";
export type AgentStatus = "active" | "inactive";
export type AgentObjective = "qualification_only" | "qualification_and_booking" | "booking_only";
export type ConversationStatus = "active" | "qualified" | "booked" | "disqualified" | "handed_off" | "stale";
export type QueueStatus = "pending" | "processing" | "completed" | "failed";
export type TargetingRuleType = "tag" | "custom_field" | "pipeline_stage" | "message";

/** Operadores de texto pro type="message" (Pedro 2026-06-17). Espelha TextOp em
 *  @/lib/account-assistant/filter-engine/text-ops (o matcher). */
export type MessageMatchOp =
  | "contains"
  | "not_contains"
  | "eq"
  | "starts_with"
  | "ends_with"
  | "in"
  | "matches_regex";

export interface TargetingRule {
  id: string;
  type: TargetingRuleType;
  tag?: string;
  custom_field_key?: string;
  custom_field_value?: string;
  pipeline_id?: string;
  pipeline_stage_id?: string;
  // type="message" (Pedro 2026-06-17): filtro por CONTEÚDO da mensagem do lead.
  message_operator?: MessageMatchOp;
  message_value?: string; // operadores single-value
  message_values?: string[]; // operador "in" (qualquer da lista)
  case_sensitive?: boolean; // default false
}

/**
 * Composição E/OU (v2, Pedro 2026-06-17). Back-compat: um array flat legado
 * (TargetingRule[]) é lido como 1 grupo "all" (= AND, idêntico ao runtime
 * legado). Ver normalizeTargeting em @/lib/queue/targeting.
 */
export interface TargetingGroup {
  id: string;
  match: "all" | "any"; // "all" = E (todas batem), "any" = OU (qualquer bate)
  rules: TargetingRule[];
}
export interface TargetingRuleSet {
  version: 2;
  match: "all" | "any"; // como combinar os GRUPOS entre si
  groups: TargetingGroup[];
}
/** O que vive em agent_configs.targeting_rules: array legado OU set v2. */
export type TargetingRules = TargetingRule[] | TargetingRuleSet;

export interface DataField {
  key: string;
  label: string;
  required: boolean;
  type: "text" | "date" | "boolean" | "select";
  options?: string[];
  sync_to_ghl?: boolean;       // true = atualiza custom field no GHL
  ghl_field_id?: string;       // ID do custom field no GHL
  ghl_field_key?: string;      // fieldKey do custom field no GHL
  skip_if_filled?: boolean;    // true = nao perguntar se ja tem valor
}

export interface FollowUpStep {
  delay_minutes: number;
  custom_message?: string;       // se vazio, a IA decide a mensagem
}

export type FollowUpMode = "ai_auto" | "manual";

export interface FollowUpConfig {
  enabled: boolean;
  mode: FollowUpMode;
  intensity: number;             // 1-10, usado no modo ai_auto
  max_attempts: number;          // maximo de follow-ups
  min_delay_minutes: number;     // tempo minimo para o 1o follow-up (default 10)
  max_delay_minutes: number;     // tempo maximo para o ultimo follow-up (default 10080 = 7 dias)
  custom_prompt?: string;        // prompt especifico para follow-ups
  manual_steps: FollowUpStep[];  // usado no modo manual
}

export interface Agent {
  id: string;
  location_id: string;
  type: AgentType;
  status: AgentStatus;
  name: string;
  created_at: string;
  updated_at: string;
}

export type CommunicationChannel = "SMS" | "WhatsApp" | "Instagram" | "Email";

export type PostBookingBehavior = "stop_and_handoff" | "continue_until_appointment";

export interface PostBookingConfig {
  behavior: PostBookingBehavior;
  handoff_message: string;          // mensagem ao passar para humano
  allow_reschedule: boolean;        // permite reagendamento
}

export type AgentIdentityMode = "assistant" | "human";

export interface AgentPersonality {
  name: string;                    // Nome da IA (ex: "Ana", "Spark")
  identity_mode: AgentIdentityMode; // Se apresenta como assistente virtual ou humano
  greeting_style: string;          // Como cumprimenta (ex: "Oi {name}!", "Ola, tudo bem?")
  farewell_style: string;          // Como se despede
  language: string;                // Idioma principal (pt-BR, en-US, es)
  persona_description: string;     // Descricao livre da personalidade
}

export interface AgentConfig {
  id: string;
  agent_id: string;
  personality: AgentPersonality;
  targeting_rules: TargetingRule[];
  enabled_channels: CommunicationChannel[];
  calendar_id: string | null;
  tone_creativity: number;
  tone_formality: number;
  tone_naturalness: number;
  tone_aggressiveness: number; // 0-100: 0=passivo, 100=agressivo na venda
  objective: AgentObjective;
  post_booking: PostBookingConfig;
  data_fields: DataField[];
  ai_model: string;
  custom_instructions: string;
  conversation_examples?: string;
  knowledge_base_instructions: string;
  system_prompt_override: string | null;
  debounce_seconds: number;
  max_messages_per_conversation: number;
  working_hours: WorkingHoursConfig;
  follow_up_config: FollowUpConfig;
  timezone_config: TimezoneConfig;
  notifications: NotificationsConfig;
  automations: AutomationRule[];
  deactivation_rules: DeactivationRule[];
  handoff_messages: HandoffMessage[];
  auto_pause_on_human_message: boolean;
  // Media features
  enable_audio_transcription?: boolean;
  enable_image_analysis?: boolean;
  enable_pdf_reading?: boolean;
  // Summary notes
  enable_summary_notes?: boolean;
  // Recruitment specialist fields
  specialist_name?: string;        // Nome do especialista responsável pelas entrevistas
  specialist_role?: string;        // Descrição do papel ("especialista", "consultor")
  check_legal_docs?: boolean;      // Pergunta sobre Social Security e permissão de trabalho (EUA)
  preferred_time_slot?: string;    // "afternoon_evening" | "any"
  // F37 (Pedro 2026-05-29): Lead awareness + handoff inteligente.
  // Migration 00096 adiciona as colunas com default JSONB. Código sempre
  // lê via getLeadHistoryConfig/getHandoffPolicy que aplica defaults se
  // null (retrocompat antes do deploy da migration).
  lead_history_config?: LeadHistoryConfig | null;
  handoff_policy?: HandoffPolicy | null;
  created_at: string;
  updated_at: string;
}

/* ─── F37 Lead Awareness + Handoff (Pedro 2026-05-29) ─────────────── */

export interface LeadHistoryConfig {
  enabled: boolean;
  /** Quantas msgs do histórico GHL trazer (10-50). */
  messages_count: number;
  /** Incluir notas/observações do contato no prompt. */
  include_notes: boolean;
  /** Incluir opportunities + stage atual. */
  include_opportunities: boolean;
  /** Incluir tags do contato. */
  include_tags: boolean;
}

export interface HandoffPolicy {
  enabled: boolean;
  /** Se rep humano respondeu nesse intervalo, bot silencia. */
  skip_if_human_replied_within_minutes: number;
  /** Lead pediu "falar com humano" → bot silencia + notifica. */
  skip_if_lead_requested_human: boolean;
  /** Quando skip, manda msg pro rep dono via SparkBot. */
  notify_rep_via_sparkbot: boolean;
  /** Opp em estágio fechado (won/lost) → bot silencia. */
  notify_on_opp_stage_closed: boolean;
  /** Keywords adicionais que disparam handoff (PT-BR + EN). */
  custom_keywords_handoff: string[];
}

export const DEFAULT_LEAD_HISTORY_CONFIG: LeadHistoryConfig = {
  enabled: false,
  messages_count: 20,
  include_notes: true,
  include_opportunities: true,
  include_tags: true,
};

export const DEFAULT_HANDOFF_POLICY: HandoffPolicy = {
  enabled: false,
  skip_if_human_replied_within_minutes: 60,
  skip_if_lead_requested_human: true,
  notify_rep_via_sparkbot: true,
  notify_on_opp_stage_closed: true,
  custom_keywords_handoff: ["humano", "atendente", "pessoa", "falar com alguem", "falar com alguém", "real person", "agent please"],
};

export function getLeadHistoryConfig(c: { lead_history_config?: LeadHistoryConfig | null }): LeadHistoryConfig {
  return { ...DEFAULT_LEAD_HISTORY_CONFIG, ...(c.lead_history_config || {}) };
}

export function getHandoffPolicy(c: { handoff_policy?: HandoffPolicy | null }): HandoffPolicy {
  return { ...DEFAULT_HANDOFF_POLICY, ...(c.handoff_policy || {}) };
}

/** Snapshot do contexto histórico do lead carregado do Spark Leads. */
export interface LeadContext {
  contact: {
    id: string;
    name: string;
    phone?: string;
    email?: string;
    tags: string[];
    customFields: Array<{ key: string; value: string }>;
    assignedUserId?: string;
  };
  recent_messages: Array<{
    direction: "inbound" | "outbound";
    body: string;
    dateAdded: string;
    source?: string; // "api" | "workflow" | "app" | null
    userId?: string; // GHL user que enviou (humano manual no inbox); ausente/admin em api/automação/IA-eco
    messageType?: string;
  }>;
  notes: Array<{ body: string; dateAdded: string; userId?: string }>;
  opportunities: Array<{
    id: string;
    name?: string;
    pipelineId?: string;
    pipelineStageId?: string;
    pipelineName?: string;
    stageName?: string;
    status?: string; // "open" | "won" | "lost" | "abandoned"
    monetaryValue?: number;
    assignedTo?: string;
  }>;
  /** ISO da última msg outbound NÃO-bot (source != 'api'). */
  last_human_outbound_at: string | null;
  /** ISO da última msg inbound. */
  last_inbound_at: string | null;
  /** Tem opp em status 'won'/'lost'/'abandoned'? */
  has_closed_opp: boolean;
  /** Quanto tempo levou pra carregar (debug). */
  fetch_ms: number;
}

export type ShouldRespondDecision =
  | { decision: "respond"; reason?: string }
  | { decision: "skip"; reason: string; notify_rep: boolean; suggested_action?: string };

export interface AutomationAction {
  type:
    | "add_tag"
    | "remove_tag"
    | "move_pipeline"
    | "update_field"
    | "send_media"
    | "send_text_fixed"
    | "pause_ai"
    | "webhook";
  // add_tag / remove_tag
  tag?: string;
  // move_pipeline
  pipeline_id?: string;
  stage_id?: string;
  // update_field
  field_key?: string;
  field_value?: string;
  // send_media
  media_id?: string;
  media_caption?: string;
  // send_text_fixed
  text?: string;
  // pause_ai
  pause_minutes?: number; // 0 = indefinido
  // webhook
  webhook_url?: string;
}

/**
 * Trigger (condicao de disparo) de uma automation.
 * - event-based: dispara em eventos de conversation_status (qualified, booked, etc)
 * - data-field-based: dispara quando um campo do collected_data muda para um valor
 */
export type AutomationTrigger =
  | {
      kind: "event";
      event: string; // "qualified" | "booked" | "handed_off" | custom
      event_label?: string;
    }
  | {
      kind: "on_data_field_set";
      field_key: string;
      operator: "any_value" | "equals" | "contains" | "matches_regex";
      value?: string;
    };

export interface AutomationRule {
  id: string;
  // Campos legados (compatibilidade com regras event-based criadas antes do trigger explicito)
  event?: string;
  event_label?: string;
  // Trigger explicito (novo). Se ausente, interpretamos como { kind: "event", event }
  trigger?: AutomationTrigger;
  actions: AutomationAction[];
}

export interface DeactivationRule {
  id: string;
  type: "tag_added" | "tag_removed" | "custom_field_equals";
  tag?: string;
  field_key?: string;
  field_value?: string;
}

/**
 * Mensagem de encerramento manual. Quando o operador humano envia uma
 * dessas mensagens ao contato (via GHL), a IA pode ser pausada
 * automaticamente para aquele contato especifico.
 */
export interface HandoffMessage {
  id: string;
  label: string;          // nome amigavel pro admin identificar
  text: string;           // conteudo exato da mensagem
  auto_deactivate: boolean; // se true, pausa a IA ao enviar essa mensagem
}

export interface TimezoneConfig {
  use_location_default: boolean;     // true = usa timezone da location
  custom_timezone: string;           // timezone customizado (ex: "America/Chicago")
  confirm_before_booking: boolean;   // perguntar timezone antes de agendar
  auto_detect_from_state: boolean;   // detectar timezone pelo estado do lead
}

export interface NotificationsConfig {
  on_qualified: boolean;
  on_booked: boolean;
  on_handed_off: boolean;
  on_error: boolean;
  notification_email: string;
}

export interface WorkingHoursDay {
  enabled: boolean;
  start: string; // "09:00"
  end: string;   // "17:00"
}

export interface WorkingHoursConfig {
  enabled: boolean;
  timezone: string;
  mode: "only_during" | "only_outside";
  schedule: Record<string, WorkingHoursDay>;
}

export interface ConversationState {
  id: string;
  agent_id: string;
  location_id: string;
  contact_id: string;
  conversation_id: string;
  status: ConversationStatus;
  collected_data: Record<string, string>;
  message_count: number;
  last_message_at: string | null;
  last_ai_response_at: string | null;
  ai_paused_at: string | null;
  ai_paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageQueueItem {
  id: string;
  location_id: string;
  contact_id: string;
  conversation_id: string;
  message_body: string;
  message_type: string;
  message_direction: string;
  ghl_message_id: string | null;
  received_at: string;
  process_after: string;
  status: QueueStatus;
  created_at: string;
}

export interface ExecutionLog {
  id: string;
  agent_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  location_id: string;
  action_type: string;
  action_payload: Record<string, unknown>;
  ai_model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  success: boolean;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
}

// Agent with its config (joined)
export interface AgentWithConfig extends Agent {
  config: AgentConfig | null;
}

// Default data fields for insurance sales agent
export const DEFAULT_SALES_DATA_FIELDS: DataField[] = [
  { key: "full_name", label: "Nome completo", required: true, type: "text" },
  { key: "date_of_birth", label: "Data de nascimento", required: true, type: "date" },
  { key: "state", label: "Estado onde mora", required: true, type: "text" },
  { key: "smoker_status", label: "Fumante", required: true, type: "boolean" },
];

// Default data fields for recruitment agent — totalmente distinto de vendas.
// Recrutamento foca em: localização, perfil profissional e motivação/gancho.
// Máximo 3 campos obrigatórios, alinhado ao limite de "3 infos antes do agendamento".
export const DEFAULT_RECRUITMENT_DATA_FIELDS: DataField[] = [
  { key: "full_name", label: "Nome completo", required: true, type: "text" },
  { key: "state", label: "Estado onde mora", required: true, type: "text" },
  { key: "current_occupation", label: "O que a pessoa faz hoje", required: true, type: "text" },
  { key: "motivation", label: "Motivação / gancho de interesse", required: false, type: "text" },
];
