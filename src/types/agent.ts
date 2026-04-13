export type AgentType = "sales_agent" | "recruitment_agent" | "account_assistant";
export type AgentStatus = "active" | "inactive";
export type AgentObjective = "qualification_only" | "qualification_and_booking" | "booking_only";
export type ConversationStatus = "active" | "qualified" | "booked" | "disqualified" | "handed_off" | "stale";
export type QueueStatus = "pending" | "processing" | "completed" | "failed";
export type TargetingRuleType = "tag" | "custom_field" | "pipeline_stage";

export interface TargetingRule {
  id: string;
  type: TargetingRuleType;
  tag?: string;
  custom_field_key?: string;
  custom_field_value?: string;
  pipeline_id?: string;
  pipeline_stage_id?: string;
}

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
  // Recruitment-specific
  specialist_name?: string;        // Nome do especialista que faz o Zoom
  specialist_role?: string;        // Descrição do papel ("especialista", "recrutadora")
  check_legal_docs?: boolean;      // Verificar documentação legal (SSN, work permit)
  preferred_time_slot?: string;    // "afternoon_evening" | "any"
  created_at: string;
  updated_at: string;
}

export interface AutomationAction {
  type: "add_tag" | "remove_tag" | "move_pipeline" | "update_field";
  tag?: string;
  pipeline_id?: string;
  stage_id?: string;
  field_key?: string;
  field_value?: string;
}

export interface AutomationRule {
  id: string;
  event: string;  // "qualified" | "booked" | "handed_off" | "disqualified" | custom
  event_label?: string; // Label para eventos custom
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
