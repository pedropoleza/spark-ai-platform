-- =====================================================
-- Spark AI Hub - Supabase Consolidated Migration
-- Rode este arquivo inteiro no SQL Editor do Supabase.
-- Projeto: hfmocggdiyvydtxjqthp
--
-- NOTA: Ordem reorganizada em relação ao diretório migrations/
-- para resolver dependências (knowledge_base, scheduled_followups)
-- que no histórico original foram aplicadas manualmente em ordem diferente.
-- =====================================================

-- =====================================================
-- 00001: locations
-- =====================================================
CREATE TABLE IF NOT EXISTS locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   TEXT NOT NULL UNIQUE,
  company_id    TEXT NOT NULL,
  location_name TEXT,
  timezone      TEXT DEFAULT 'America/New_York',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_locations_location_id ON locations(location_id);
CREATE INDEX IF NOT EXISTS idx_locations_company_id ON locations(company_id);

-- =====================================================
-- 00002: agents
-- =====================================================
DO $$ BEGIN
  CREATE TYPE agent_type AS ENUM ('sales_agent', 'account_assistant');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE agent_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  type          agent_type NOT NULL,
  status        agent_status NOT NULL DEFAULT 'inactive',
  name          TEXT NOT NULL DEFAULT 'Agente de Vendas',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(location_id, type)
);
CREATE INDEX IF NOT EXISTS idx_agents_location_id ON agents(location_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status) WHERE status = 'active';

-- Adiciona recruitment_agent (moved up from 00015)
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'recruitment_agent';

-- =====================================================
-- 00003+00015: agent_configs (com todas as colunas agregadas)
-- =====================================================
DO $$ BEGIN
  CREATE TYPE agent_objective AS ENUM (
    'qualification_only',
    'qualification_and_booking',
    'booking_only'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS agent_configs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  pipeline_id       TEXT,
  pipeline_stage_id TEXT,
  targeting_mode    TEXT DEFAULT 'tag' CHECK (targeting_mode IN ('tag', 'custom_field')),
  targeting_tag     TEXT,
  targeting_field_key   TEXT,
  targeting_field_value TEXT,
  calendar_id       TEXT,
  tone_creativity   INTEGER DEFAULT 50 CHECK (tone_creativity BETWEEN 0 AND 100),
  tone_formality    INTEGER DEFAULT 50 CHECK (tone_formality BETWEEN 0 AND 100),
  objective         agent_objective DEFAULT 'qualification_and_booking',
  data_fields       JSONB DEFAULT '[
    {"key":"full_name","label":"Nome completo","required":true,"type":"text"},
    {"key":"date_of_birth","label":"Data de nascimento","required":true,"type":"date"},
    {"key":"state","label":"Estado onde mora","required":true,"type":"text"},
    {"key":"smoker_status","label":"Fumante","required":true,"type":"boolean"}
  ]'::jsonb,
  ai_model          TEXT DEFAULT 'gpt-4o',
  custom_instructions TEXT DEFAULT '',
  system_prompt_override TEXT,
  debounce_seconds  INTEGER DEFAULT 15 CHECK (debounce_seconds BETWEEN 5 AND 60),
  max_messages_per_conversation INTEGER DEFAULT 50,
  business_hours_only BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Colunas adicionais (00011, 00012, 00015, 00019, 00023, 00024)
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS knowledge_base_instructions TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS auto_pause_on_human_message BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS personality JSONB DEFAULT '{"name":"Assistente","identity_mode":"assistant","greeting_style":"Oi {name}!","farewell_style":"Qualquer duvida, estou por aqui!","language":"pt-BR","persona_description":""}'::jsonb,
  ADD COLUMN IF NOT EXISTS targeting_rules JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS enabled_channels JSONB DEFAULT '["SMS","WhatsApp"]'::jsonb,
  ADD COLUMN IF NOT EXISTS tone_naturalness INTEGER DEFAULT 50 CHECK (tone_naturalness BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS tone_aggressiveness INTEGER DEFAULT 50 CHECK (tone_aggressiveness BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '{"enabled":false,"timezone":"America/New_York","mode":"only_during","schedule":{"monday":{"enabled":true,"start":"09:00","end":"17:00"},"tuesday":{"enabled":true,"start":"09:00","end":"17:00"},"wednesday":{"enabled":true,"start":"09:00","end":"17:00"},"thursday":{"enabled":true,"start":"09:00","end":"17:00"},"friday":{"enabled":true,"start":"09:00","end":"17:00"},"saturday":{"enabled":false,"start":"09:00","end":"13:00"},"sunday":{"enabled":false,"start":"09:00","end":"13:00"}}}'::jsonb,
  ADD COLUMN IF NOT EXISTS follow_up_config JSONB DEFAULT '{"enabled":false,"mode":"ai_auto","intensity":5,"max_attempts":5,"min_delay_minutes":10,"max_delay_minutes":10080,"custom_prompt":"","manual_steps":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS post_booking JSONB DEFAULT '{"behavior":"stop_and_handoff","handoff_message":"Obrigado! Um membro da equipe entrara em contato.","allow_reschedule":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS timezone_config JSONB DEFAULT '{"use_location_default":true,"custom_timezone":"","confirm_before_booking":true,"auto_detect_from_state":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS automations JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS deactivation_rules JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS handoff_messages JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notifications JSONB DEFAULT '{"on_qualified":false,"on_booked":false,"on_handed_off":false,"on_error":false,"notification_email":""}'::jsonb,
  ADD COLUMN IF NOT EXISTS specialist_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS specialist_role TEXT DEFAULT 'especialista',
  ADD COLUMN IF NOT EXISTS check_legal_docs BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preferred_time_slot TEXT DEFAULT 'afternoon_evening',
  ADD COLUMN IF NOT EXISTS enable_audio_transcription BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_image_analysis BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_pdf_reading BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_summary_notes BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conversation_examples TEXT;

-- =====================================================
-- 00004+00009+00014+00023+00025: conversation_state
-- =====================================================
DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM (
    'active', 'qualified', 'booked', 'disqualified', 'handed_off', 'stale'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS conversation_state (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id       TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  status            conversation_status DEFAULT 'active',
  collected_data    JSONB DEFAULT '{}'::jsonb,
  message_count     INTEGER DEFAULT 0,
  last_message_at   TIMESTAMPTZ,
  last_ai_response_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_state_location ON conversation_state(location_id);
CREATE INDEX IF NOT EXISTS idx_conversation_state_contact ON conversation_state(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversation_state_status ON conversation_state(status) WHERE status = 'active';

ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS triggered_automations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS summary_note_id TEXT,
  ADD COLUMN IF NOT EXISTS summary_note_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS segment_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS history_summary TEXT,
  ADD COLUMN IF NOT EXISTS history_summary_covers_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conversation_state_ai_paused
  ON conversation_state(ai_paused_at) WHERE ai_paused_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_state_inactivity_scan
  ON conversation_state(status, last_ai_response_at)
  WHERE status = 'active' AND summary_note_id IS NULL;

-- =====================================================
-- 00005+00013+00016+00018+00020+00021: message_queue
-- =====================================================
DO $$ BEGIN
  CREATE TYPE queue_status AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS message_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  message_body      TEXT NOT NULL,
  message_type      TEXT DEFAULT 'SMS',
  message_direction TEXT DEFAULT 'inbound',
  ghl_message_id    TEXT,
  received_at       TIMESTAMPTZ DEFAULT now(),
  process_after     TIMESTAMPTZ NOT NULL,
  status            queue_status DEFAULT 'pending',
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_queue_ready
  ON message_queue(process_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_message_queue_contact
  ON message_queue(location_id, contact_id, status);

ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'SMS',
  ADD COLUMN IF NOT EXISTS audio_url TEXT,
  ADD COLUMN IF NOT EXISTS audio_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS media_attachments JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_message_queue_agent
  ON message_queue(agent_id) WHERE agent_id IS NOT NULL;

-- Dedup de webhooks
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_ghl_dedup
  ON message_queue(ghl_message_id) WHERE ghl_message_id IS NOT NULL;

-- =====================================================
-- 00006: execution_log
-- =====================================================
CREATE TABLE IF NOT EXISTS execution_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id   TEXT,
  contact_id        TEXT,
  location_id       TEXT NOT NULL,
  action_type       TEXT NOT NULL,
  action_payload    JSONB DEFAULT '{}'::jsonb,
  ai_model_used     TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  success           BOOLEAN DEFAULT true,
  error_message     TEXT,
  duration_ms       INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_log_location ON execution_log(location_id);
CREATE INDEX IF NOT EXISTS idx_execution_log_created ON execution_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_log_agent ON execution_log(agent_id) WHERE agent_id IS NOT NULL;

-- =====================================================
-- knowledge_base (00017 + 00010)
-- =====================================================
CREATE TABLE IF NOT EXISTS knowledge_base (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id         TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('text', 'file', 'url')),
  title               TEXT NOT NULL,
  content             TEXT NOT NULL DEFAULT '',
  file_name           TEXT,
  file_url            TEXT,
  token_count         INTEGER DEFAULT 0,
  description         TEXT,
  usage_instructions  TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_agent ON knowledge_base(agent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_location ON knowledge_base(location_id);

-- =====================================================
-- 00014: media_library
-- =====================================================
CREATE TABLE IF NOT EXISTS media_library (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_library_agent ON media_library(agent_id);
CREATE INDEX IF NOT EXISTS idx_media_library_location ON media_library(location_id);

-- =====================================================
-- scheduled_followups (faltava nas migrations — reconstruído do uso no código)
-- =====================================================
CREATE TABLE IF NOT EXISTS scheduled_followups (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id       TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  conversation_id   TEXT,
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  custom_message    TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'failed')),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followups_agent_contact
  ON scheduled_followups(agent_id, contact_id, status);

-- =====================================================
-- 00022: performance indexes
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_exec_log_contact_action
  ON execution_log(location_id, contact_id, action_type, created_at DESC)
  WHERE success = true;
CREATE INDEX IF NOT EXISTS idx_exec_log_agent_activity
  ON execution_log(agent_id, location_id, action_type, created_at DESC)
  WHERE success = true;
CREATE INDEX IF NOT EXISTS idx_followups_pending
  ON scheduled_followups(status, scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_exec_log_location_action
  ON execution_log(location_id, action_type, created_at DESC)
  WHERE success = true;

-- =====================================================
-- 00026: Backfill recruitment_agent defaults
-- (no-op em DB novo, mas mantido por idempotência)
-- =====================================================
UPDATE agent_configs AS ac
SET data_fields = '[
  {"key":"full_name","label":"Nome completo","required":true,"type":"text"},
  {"key":"state","label":"Estado onde mora","required":true,"type":"text"},
  {"key":"current_occupation","label":"O que a pessoa faz hoje","required":true,"type":"text"},
  {"key":"motivation","label":"Motivação / gancho de interesse","required":false,"type":"text"}
]'::jsonb,
preferred_time_slot = COALESCE(NULLIF(ac.preferred_time_slot, ''), 'afternoon_evening'),
specialist_role = COALESCE(NULLIF(ac.specialist_role, ''), 'especialista')
FROM agents AS a
WHERE ac.agent_id = a.id
  AND a.type = 'recruitment_agent'
  AND ac.data_fields @> '[{"key":"smoker_status"}]'::jsonb;

-- =====================================================
-- 00027: agent_test_sessions + messages
-- =====================================================
CREATE TABLE IF NOT EXISTS agent_test_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  session_name  TEXT,
  contact_id    TEXT,
  collected_data JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_test_sessions_agent
  ON agent_test_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_test_sessions_recent
  ON agent_test_sessions(agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_test_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES agent_test_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  content     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_test_messages_session
  ON agent_test_messages(session_id, created_at);

CREATE OR REPLACE FUNCTION touch_test_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE agent_test_sessions
  SET updated_at = NEW.created_at
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_test_session ON agent_test_messages;
CREATE TRIGGER trg_touch_test_session
  AFTER INSERT ON agent_test_messages
  FOR EACH ROW
  EXECUTE FUNCTION touch_test_session_updated_at();

-- =====================================================
-- 00007: RLS
-- =====================================================
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_test_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_test_messages ENABLE ROW LEVEL SECURITY;

-- Como o app usa GHL SSO (não Supabase Auth) e service_role key
-- via API routes do Next.js, RLS fica ativo mas sem policies explícitas.
-- service_role ignora RLS por padrão; anon não tem acesso.

-- =====================================================
-- 00008: pg_cron (comentado — habilite manualmente após deploy)
-- =====================================================
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net;
--
-- Depois do deploy no Vercel, substitua YOUR_APP_URL e YOUR_CRON_SECRET:
-- SELECT cron.schedule(
--   'process-message-queue', '10 seconds',
--   $$
--   SELECT net.http_post(
--     url := 'https://YOUR_APP_URL/api/agents/process-batch',
--     headers := '{"Authorization": "Bearer YOUR_CRON_SECRET", "Content-Type": "application/json"}'::jsonb,
--     body := '{}'::jsonb
--   ) WHERE EXISTS (
--     SELECT 1 FROM message_queue
--     WHERE status = 'pending' AND process_after <= now() LIMIT 1
--   );
--   $$
-- );
