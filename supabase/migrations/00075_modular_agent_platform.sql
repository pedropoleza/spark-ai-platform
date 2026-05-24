-- ============================================================================
-- 00075_modular_agent_platform.sql
-- Plataforma Modular de Agentes — FASE 0 (fundações). Aditivo e reversível.
--
-- Motivação (Pedro 2026-05-24, discovery): SparkBot vira incluso/grátis;
-- Venda/Recrutamento/Custom viram upsell pago, montados a partir de MÓDULOS
-- que se encaixam sobre um motor único. Venda/recrut atuais viram TEMPLATES.
-- Migração é segura — nenhum cliente lead-facing em prod hoje (piloto: Alves Cury).
--
-- Decisões e desenho completos: _planning/plataforma-modular/PLANO.md (D1-D12).
--
-- Esta migração SÓ cria o esqueleto de dados + backfill + seed de catálogo e
-- entitlements. NÃO muda nenhum comportamento de runtime (SparkBot intocado).
-- Convenções reusadas: touch_updated_at() (00040), RLS deny_anon_all RESTRICTIVE.
-- ============================================================================

-- 1) AUDIÊNCIA — eixo central rep-facing (SparkBot) x lead-facing (venda/recrut/custom)
DO $$ BEGIN
  CREATE TYPE agent_audience AS ENUM ('rep', 'lead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) COLUNAS NOVAS em agents (aditivas, nullable — nada quebra)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS audience     agent_audience,
  ADD COLUMN IF NOT EXISTS template_key TEXT,
  ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ;  -- D11: agente temporário

-- backfill audience por tipo (account_assistant=rep; resto=lead)
UPDATE agents SET audience = 'rep'
  WHERE audience IS NULL AND type = 'account_assistant';
UPDATE agents SET audience = 'lead'
  WHERE audience IS NULL AND type IN ('sales_agent', 'recruitment_agent');

COMMENT ON COLUMN agents.audience IS 'rep-facing (fala com o user/rep) vs lead-facing (fala com leads/contatos). Eixo central da plataforma modular (PLANO D2).';
COMMENT ON COLUMN agents.expires_at IS 'Agente temporário (evento). Na data, pausa sozinho — não deleta (PLANO D11).';

-- 3) TEMPLATES — bases curadas pela agência (seed: sparkbot, sales, recruitment)
CREATE TABLE IF NOT EXISTS agent_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  audience        agent_audience NOT NULL,
  description     TEXT,
  version         INT NOT NULL DEFAULT 1,
  base_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_modules JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array de module keys
  is_seed         BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'active',       -- active|draft|archived
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4) MÓDULOS — catálogo curado. prompt_fragment NULL = usa o do registry TS por key.
CREATE TABLE IF NOT EXISTS agent_modules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,                  -- behavior|active_hours|followup|qualification|scheduling|compliance|channel|crm_ops|knowledge
  version         INT NOT NULL DEFAULT 1,
  audience_scope  TEXT NOT NULL DEFAULT 'both',   -- rep|lead|both
  prompt_fragment TEXT,                            -- NULL = registry TS provê (Fase 1)
  allowed_tools   TEXT[] NOT NULL DEFAULT '{}',
  settings_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  guardrails      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'active',  -- active|draft|archived
  is_seed         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

-- 5) COMPOSIÇÃO por agente — módulos ligados + settings + override + ordem
CREATE TABLE IF NOT EXISTS agent_module_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  module_key      TEXT NOT NULL,
  module_version  INT NOT NULL DEFAULT 1,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_override TEXT,                            -- override livre por agente (D9 — não-limitar)
  sort_order      INT NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, module_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_module_instances_agent ON agent_module_instances(agent_id);

-- 6) ENTITLEMENTS — capacidade paga liberada por location (D6: manual agora)
CREATE TABLE IF NOT EXISTS agent_entitlements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  capability   TEXT NOT NULL,                      -- sales_agent|recruitment_agent|custom_agent
  status       TEXT NOT NULL DEFAULT 'active',     -- active|revoked
  source       TEXT NOT NULL DEFAULT 'manual',     -- manual|purchase
  granted_by   TEXT,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- no máximo 1 entitlement ATIVO por (location, capability)
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_entitlements_active
  ON agent_entitlements(location_id, capability) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agent_entitlements_location ON agent_entitlements(location_id);

-- 7) updated_at automático (reusa touch_updated_at de 00040)
DROP TRIGGER IF EXISTS trg_touch_agent_templates ON agent_templates;
CREATE TRIGGER trg_touch_agent_templates BEFORE UPDATE ON agent_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_agent_modules ON agent_modules;
CREATE TRIGGER trg_touch_agent_modules BEFORE UPDATE ON agent_modules
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_agent_module_instances ON agent_module_instances;
CREATE TRIGGER trg_touch_agent_module_instances BEFORE UPDATE ON agent_module_instances
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_agent_entitlements ON agent_entitlements;
CREATE TRIGGER trg_touch_agent_entitlements BEFORE UPDATE ON agent_entitlements
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 8) RLS — deny anon (service role bypassa; app usa service role). Convenção 00040.
ALTER TABLE agent_templates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_modules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_module_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_entitlements     ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_anon_all ON agent_templates        AS RESTRICTIVE FOR ALL TO anon USING (false);
CREATE POLICY deny_anon_all ON agent_modules          AS RESTRICTIVE FOR ALL TO anon USING (false);
CREATE POLICY deny_anon_all ON agent_module_instances AS RESTRICTIVE FOR ALL TO anon USING (false);
CREATE POLICY deny_anon_all ON agent_entitlements     AS RESTRICTIVE FOR ALL TO anon USING (false);

-- ============================================================================
-- SEED — catálogo de módulos (metadata; prompt_fragment/tools entram na Fase 1)
-- ============================================================================
INSERT INTO agent_modules (key, name, category, audience_scope, is_seed) VALUES
  ('behavior',      'Comportamento e Naturalidade', 'behavior',      'both', true),
  ('active_hours',  'Janela de Tempo',              'active_hours',  'both', true),
  ('followup',      'Follow-up Automático',         'followup',      'both', true),
  ('qualification', 'Qualificação (data fields)',   'qualification', 'lead', true),
  ('scheduling',    'Agendamento',                  'scheduling',    'both', true),
  ('compliance',    'Anti-spam / Opt-out',          'compliance',    'lead', true),
  ('channel',       'Canal (WhatsApp/IG/…)',        'channel',       'both', true),
  ('crm_ops',       'Operações no CRM',             'crm_ops',       'both', true),
  ('knowledge',     'Base de Conhecimento',         'knowledge',     'both', true)
ON CONFLICT (key, version) DO NOTHING;

-- SEED — templates (bases). default_modules = keys do catálogo acima.
INSERT INTO agent_templates (key, name, audience, description, default_modules, is_seed) VALUES
  ('sparkbot',    'SparkBot (assistente do rep)', 'rep',
     'Assistente que opera o CRM pro próprio rep. Incluso em toda conta.',
     '["behavior","active_hours","scheduling","crm_ops","knowledge","followup"]'::jsonb, true),
  ('sales',       'Agente de Vendas',             'lead',
     'Qualifica e agenda leads de venda em nome do rep.',
     '["behavior","active_hours","qualification","scheduling","followup","compliance","channel"]'::jsonb, true),
  ('recruitment', 'Agente de Recrutamento',       'lead',
     'Qualifica e agenda candidatos de recrutamento.',
     '["behavior","active_hours","qualification","scheduling","followup","compliance","channel"]'::jsonb, true)
ON CONFLICT (key) DO NOTHING;

-- SEED — não quebrar ninguém: libera entitlement pros agentes lead ATIVOS hoje.
-- (idempotente via NOT EXISTS; ex: Alves Cury Financial)
INSERT INTO agent_entitlements (location_id, capability, source, granted_by, notes)
SELECT DISTINCT a.location_id, a.type::text, 'manual', 'migration_00075',
       'auto-seed: agente lead ativo no momento da migração modular'
FROM agents a
WHERE a.type IN ('sales_agent', 'recruitment_agent')
  AND a.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM agent_entitlements e
    WHERE e.location_id = a.location_id
      AND e.capability = a.type::text
      AND e.status = 'active'
  );
