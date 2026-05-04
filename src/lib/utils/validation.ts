import { z } from "zod";

// SSO
export const ssoSchema = z.object({
  user_id: z.string().min(1),
  company_id: z.string().min(1),
  location_id: z.string().min(1),
});

// Criar agente
export const createAgentSchema = z.object({
  type: z.enum(["sales_agent", "recruitment_agent", "account_assistant"]),
});

// Atualizar agente
export const updateAgentSchema = z.object({
  status: z.enum(["active", "inactive"]).optional(),
  name: z.string().min(1).max(255).optional(),
});

// Targeting rule
const targetingRuleSchema = z.object({
  id: z.string(),
  type: z.enum(["tag", "custom_field", "pipeline_stage"]),
  tag: z.string().optional(),
  custom_field_key: z.string().optional(),
  custom_field_value: z.string().optional(),
  pipeline_id: z.string().optional(),
  pipeline_stage_id: z.string().optional(),
});

// Data field
const dataFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
  type: z.enum(["text", "date", "boolean", "select"]),
  options: z.array(z.string()).optional(),
  sync_to_ghl: z.boolean().optional(),
  ghl_field_id: z.string().optional(),
  ghl_field_key: z.string().optional(),
  skip_if_filled: z.boolean().optional(),
});

// Follow-up step
const followUpStepSchema = z.object({
  delay_minutes: z.number().min(1),
  custom_message: z.string().optional(),
});

// Follow-up config
const followUpConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["ai_auto", "manual"]),
  intensity: z.number().min(1).max(10),
  max_attempts: z.number().min(1).max(20),
  min_delay_minutes: z.number().min(1).optional(),
  max_delay_minutes: z.number().min(1).optional(),
  custom_prompt: z.string().optional(),
  manual_steps: z.array(followUpStepSchema),
});

// Working hours
const workingHoursDaySchema = z.object({
  enabled: z.boolean(),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

const workingHoursSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1),
  mode: z.enum(["only_during", "only_outside"]),
  schedule: z.record(z.string(), workingHoursDaySchema),
});

// Agent config update
// Limites de tamanho em campos free-text que vão parar no prompt da IA.
// Objetivo: prevenir prompt injection abusivo + cortar custo de tokens.
const personalitySchema = z.object({
  name: z.string().max(100),
  identity_mode: z.enum(["assistant", "human"]),
  greeting_style: z.string().max(500),
  farewell_style: z.string().max(500),
  language: z.string().max(50),
  persona_description: z.string().max(2000),
});

export const updateAgentConfigSchema = z.object({
  personality: personalitySchema.nullable().optional(),
  targeting_rules: z.array(targetingRuleSchema).nullable().optional(),
  enabled_channels: z.array(z.enum(["SMS", "WhatsApp", "Instagram", "Email"])).nullable().optional(),
  calendar_id: z.string().nullable().optional(),
  tone_creativity: z.number().min(0).max(100).nullable().optional(),
  tone_formality: z.number().min(0).max(100).nullable().optional(),
  tone_naturalness: z.number().min(0).max(100).nullable().optional(),
  tone_aggressiveness: z.number().min(0).max(100).nullable().optional(),
  objective: z.enum(["qualification_only", "qualification_and_booking", "booking_only"]).nullable().optional(),
  data_fields: z.array(dataFieldSchema).nullable().optional(),
  ai_model: z.string().min(1).max(100).nullable().optional(),
  custom_instructions: z.string().max(10000).nullable().optional(),
  conversation_examples: z.string().max(20000).nullable().optional(),
  knowledge_base_instructions: z.string().max(10000).nullable().optional(),
  system_prompt_override: z.string().max(20000).nullable().optional(),
  debounce_seconds: z.number().min(5).max(60).nullable().optional(),
  max_messages_per_conversation: z.number().min(10).max(200).nullable().optional(),
  working_hours: workingHoursSchema.nullable().optional(),
  follow_up_config: followUpConfigSchema.nullable().optional(),
  post_booking: z.object({
    behavior: z.enum(["stop_and_handoff", "continue_until_appointment"]),
    handoff_message: z.string(),
    allow_reschedule: z.boolean(),
  }).nullable().optional(),
  timezone_config: z.object({
    use_location_default: z.boolean(),
    custom_timezone: z.string(),
    confirm_before_booking: z.boolean(),
    auto_detect_from_state: z.boolean(),
  }).nullable().optional(),
  automations: z.array(z.object({
    id: z.string(),
    event: z.string().optional(),
    event_label: z.string().optional(),
    trigger: z
      .union([
        z.object({
          kind: z.literal("event"),
          event: z.string(),
          event_label: z.string().optional(),
        }),
        z.object({
          kind: z.literal("on_data_field_set"),
          field_key: z.string().min(1),
          operator: z.enum(["any_value", "equals", "contains", "matches_regex"]),
          value: z.string().optional(),
        }),
      ])
      .optional(),
    actions: z.array(
      z.object({
        type: z.enum([
          "add_tag",
          "remove_tag",
          "move_pipeline",
          "update_field",
          "send_media",
          "send_text_fixed",
          "pause_ai",
          "webhook",
        ]),
        tag: z.string().optional(),
        pipeline_id: z.string().optional(),
        stage_id: z.string().optional(),
        field_key: z.string().optional(),
        field_value: z.string().optional(),
        media_id: z.string().optional(),
        media_caption: z.string().optional(),
        text: z.string().optional(),
        pause_minutes: z.number().int().min(0).max(10080).optional(),
        webhook_url: z.string().url().optional(),
      })
    ),
  })).nullable().optional(),
  specialist_name: z.string().nullable().optional(),
  specialist_role: z.string().nullable().optional(),
  check_legal_docs: z.boolean().nullable().optional(),
  preferred_time_slot: z.string().nullable().optional(),
  deactivation_rules: z.array(z.object({
    id: z.string(),
    type: z.enum(["tag_added", "tag_removed", "custom_field_equals"]),
    tag: z.string().optional(),
    field_key: z.string().optional(),
    field_value: z.string().optional(),
  })).nullable().optional(),
  handoff_messages: z.array(z.object({
    id: z.string(),
    label: z.string().min(1).max(100),
    text: z.string().min(1).max(2000),
    auto_deactivate: z.boolean(),
  })).nullable().optional(),
  auto_pause_on_human_message: z.boolean().nullable().optional(),
  enable_audio_transcription: z.boolean().nullable().optional(),
  enable_image_analysis: z.boolean().nullable().optional(),
  enable_pdf_reading: z.boolean().nullable().optional(),
  enable_summary_notes: z.boolean().nullable().optional(),
  notifications: z.object({
    on_qualified: z.boolean(),
    on_booked: z.boolean(),
    on_handed_off: z.boolean(),
    on_error: z.boolean(),
    notification_email: z.string(),
  }).nullable().optional(),
  // Sparkbot-specific configs (added 2026-05-03 — Pedro Sprint 1)
  confirmation_mode: z.enum(["always", "medium_and_high", "high_only"]).nullable().optional(),
  no_response_threshold: z.number().int().min(1).max(20).nullable().optional(),
  quiet_hours: z.object({
    enabled: z.boolean(),
    start: z.string(),       // "HH:MM"
    end: z.string(),         // "HH:MM"
    timezone: z.string(),
    days: z.array(z.number().int().min(0).max(6)),
  }).nullable().optional(),
  allowed_ghl_users: z.array(z.object({
    ghl_user_id: z.string(),
    name: z.string(),
    phone: z.string().optional(),
  })).nullable().optional(),
  daily_proactive_limit: z.number().int().min(0).max(100).nullable().optional(),
  fallback_model: z.string().min(1).max(100).nullable().optional(),
  disabled_tools: z.array(z.string().min(1).max(80)).max(60).nullable().optional(),
  enabled_kbs: z.array(z.enum(["national_life_group", "agency_brazillionaires"])).nullable().optional(),
});

// Feedback
export const createFeedbackSchema = z.object({
  agent_id: z.string().min(1),
  rating: z.enum(["positive", "negative"]),
  ai_message: z.string().min(1).max(10000),
  user_message: z.string().max(10000).nullable().optional(),
  suggestion: z.string().max(5000).nullable().optional(),
  context: z.string().max(20000).nullable().optional(),
});

export const updateFeedbackSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().min(1),
  rating: z.enum(["positive", "negative"]).optional(),
  suggestion: z.string().max(5000).nullable().optional(),
});

// Teste do agente
export const testAgentSchema = z.object({
  agent_id: z.string().min(1),
  message: z.string().min(1),
  conversation_history: z.string().optional(),
  collected_data: z.record(z.string(), z.string()).optional(),
  execute_actions: z.boolean().optional(),
  contact_id: z.string().optional(),
});

// Webhook inbound
export const webhookSchema = z.object({
  locationId: z.string().optional(),
  location_id: z.string().optional(),
  contactId: z.string().optional(),
  contact_id: z.string().optional(),
  body: z.string().optional(),
  message: z.string().optional(),
  direction: z.string().optional(),
}).passthrough();

/**
 * Valida body com schema Zod. Retorna parsed data ou erro.
 */
export function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): { data: T; error: null } | { data: null; error: string } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { data: result.data, error: null };
  }
  const messages = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { data: null, error: messages };
}
