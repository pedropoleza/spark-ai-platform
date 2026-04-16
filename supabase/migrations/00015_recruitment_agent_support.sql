-- Adiciona recruitment_agent ao enum agent_type
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'recruitment_agent';

-- Colunas especificas de recrutamento na config do agente
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS specialist_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS specialist_role TEXT DEFAULT 'especialista',
  ADD COLUMN IF NOT EXISTS check_legal_docs BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preferred_time_slot TEXT DEFAULT 'afternoon_evening';
