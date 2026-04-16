-- Adiciona recruitment_agent ao enum agent_type
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'recruitment_agent';

-- ============================================================
-- Garante que TODAS as colunas usadas pelo codigo existem.
-- Muitas foram adicionadas ao codigo sem migration correspondente.
-- IF NOT EXISTS evita erro se a coluna ja existir.
-- ============================================================

ALTER TABLE agent_configs
  -- Personalidade (JSONB)
  ADD COLUMN IF NOT EXISTS personality JSONB DEFAULT '{"name":"Assistente","identity_mode":"assistant","greeting_style":"Oi {name}!","farewell_style":"Qualquer duvida, estou por aqui!","language":"pt-BR","persona_description":""}'::jsonb,

  -- Targeting rules (substitui targeting_mode/tag/field antigos)
  ADD COLUMN IF NOT EXISTS targeting_rules JSONB DEFAULT '[]'::jsonb,

  -- Canais habilitados
  ADD COLUMN IF NOT EXISTS enabled_channels JSONB DEFAULT '["SMS","WhatsApp"]'::jsonb,

  -- Tom de voz (naturalidade e agressividade)
  ADD COLUMN IF NOT EXISTS tone_naturalness INTEGER DEFAULT 50 CHECK (tone_naturalness BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS tone_aggressiveness INTEGER DEFAULT 50 CHECK (tone_aggressiveness BETWEEN 0 AND 100),

  -- Horario de funcionamento
  ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '{"enabled":false,"timezone":"America/New_York","mode":"only_during","schedule":{"monday":{"enabled":true,"start":"09:00","end":"17:00"},"tuesday":{"enabled":true,"start":"09:00","end":"17:00"},"wednesday":{"enabled":true,"start":"09:00","end":"17:00"},"thursday":{"enabled":true,"start":"09:00","end":"17:00"},"friday":{"enabled":true,"start":"09:00","end":"17:00"},"saturday":{"enabled":false,"start":"09:00","end":"13:00"},"sunday":{"enabled":false,"start":"09:00","end":"13:00"}}}'::jsonb,

  -- Follow-up automatico
  ADD COLUMN IF NOT EXISTS follow_up_config JSONB DEFAULT '{"enabled":false,"mode":"ai_auto","intensity":5,"max_attempts":5,"min_delay_minutes":10,"max_delay_minutes":10080,"custom_prompt":"","manual_steps":[]}'::jsonb,

  -- Pos-agendamento
  ADD COLUMN IF NOT EXISTS post_booking JSONB DEFAULT '{"behavior":"stop_and_handoff","handoff_message":"Obrigado! Um membro da equipe entrara em contato.","allow_reschedule":true}'::jsonb,

  -- Timezone
  ADD COLUMN IF NOT EXISTS timezone_config JSONB DEFAULT '{"use_location_default":true,"custom_timezone":"","confirm_before_booking":true,"auto_detect_from_state":true}'::jsonb,

  -- Automacoes (reacoes a eventos e dados)
  ADD COLUMN IF NOT EXISTS automations JSONB DEFAULT '[]'::jsonb,

  -- Regras de desativacao
  ADD COLUMN IF NOT EXISTS deactivation_rules JSONB DEFAULT '[]'::jsonb,

  -- Mensagens de handoff
  ADD COLUMN IF NOT EXISTS handoff_messages JSONB DEFAULT '[]'::jsonb,

  -- Notificacoes
  ADD COLUMN IF NOT EXISTS notifications JSONB DEFAULT '{"on_qualified":false,"on_booked":false,"on_handed_off":false,"on_error":false,"notification_email":""}'::jsonb,

  -- Pausa automatica em mensagem humana
  ADD COLUMN IF NOT EXISTS auto_pause_on_human_message BOOLEAN NOT NULL DEFAULT false,

  -- Instrucoes da base de conhecimento
  ADD COLUMN IF NOT EXISTS knowledge_base_instructions TEXT DEFAULT '',

  -- Campos especificos de recrutamento
  ADD COLUMN IF NOT EXISTS specialist_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS specialist_role TEXT DEFAULT 'especialista',
  ADD COLUMN IF NOT EXISTS check_legal_docs BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preferred_time_slot TEXT DEFAULT 'afternoon_evening';
