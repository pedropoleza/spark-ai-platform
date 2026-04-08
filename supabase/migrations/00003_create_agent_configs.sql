-- Tipos de objetivo
CREATE TYPE agent_objective AS ENUM (
  'qualification_only',
  'qualification_and_booking',
  'booking_only'
);

-- Configuracao detalhada de cada agente
CREATE TABLE agent_configs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,

  -- Pipeline
  pipeline_id       TEXT,
  pipeline_stage_id TEXT,

  -- Targeting de leads
  targeting_mode    TEXT DEFAULT 'tag' CHECK (targeting_mode IN ('tag', 'custom_field')),
  targeting_tag     TEXT,
  targeting_field_key   TEXT,
  targeting_field_value TEXT,

  -- Calendario
  calendar_id       TEXT,

  -- Tom (sliders 0-100)
  tone_creativity   INTEGER DEFAULT 50 CHECK (tone_creativity BETWEEN 0 AND 100),
  tone_formality    INTEGER DEFAULT 50 CHECK (tone_formality BETWEEN 0 AND 100),

  -- Objetivo
  objective         agent_objective DEFAULT 'qualification_and_booking',

  -- Campos de dados a coletar (JSON array ordenado)
  data_fields       JSONB DEFAULT '[
    {"key":"full_name","label":"Nome completo","required":true,"type":"text"},
    {"key":"date_of_birth","label":"Data de nascimento","required":true,"type":"date"},
    {"key":"state","label":"Estado onde mora","required":true,"type":"text"},
    {"key":"smoker_status","label":"Fumante","required":true,"type":"boolean"}
  ]'::jsonb,

  -- Configuracao de IA
  ai_model          TEXT DEFAULT 'gpt-4o',
  custom_instructions TEXT DEFAULT '',
  system_prompt_override TEXT,

  -- Comportamento
  debounce_seconds  INTEGER DEFAULT 15 CHECK (debounce_seconds BETWEEN 5 AND 60),
  max_messages_per_conversation INTEGER DEFAULT 50,
  business_hours_only BOOLEAN DEFAULT false,

  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
