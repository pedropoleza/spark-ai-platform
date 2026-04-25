-- Account Assistant V2 — Proactive rules system.
--
-- Sistema de regras de proatividade onde admin escreve trigger + prompt
-- instruction em linguagem natural. A IA decide tudo dinamicamente
-- (mensagem, tools a chamar). Substitui templates fixos hardcoded.

-- =====================================================
-- 1. assistant_proactive_rules: definição de cada regra
-- =====================================================
CREATE TABLE IF NOT EXISTS assistant_proactive_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- 'reactive' = dispara por evento GHL ou polling (briefing pré-reunião,
  -- no-show, opportunity stale, task vencendo etc).
  -- 'scheduled' = dispara por cron expression (resumo matinal, semanal etc).
  rule_type           TEXT NOT NULL CHECK (rule_type IN ('reactive', 'scheduled')),
  name                TEXT NOT NULL,
  description         TEXT,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  -- Trigger config (formato depende do rule_type)
  -- Reactive: { event: "appointment_upcoming", offset_minutes: -15 }
  --           { event: "appointment_no_show" }
  --           { event: "opportunity_stale", days_threshold: 7 }
  --           { event: "task_due_soon", offset_minutes: -60 }
  --           { event: "task_overdue", offset_minutes: 60 }
  --           { event: "inbound_unanswered", hours_threshold: 4 }
  --           { event: "deal_won" }
  --           { event: "contact_assigned_to_rep" }
  --           { event: "contact_inactive", days_threshold: 7 }
  --           { event: "post_meeting", offset_minutes: 20 }
  -- Scheduled: { cron: "0 8 * * 1-5", timezone: "America/New_York" }
  trigger_config      JSONB NOT NULL,
  -- Prompt em linguagem natural que descreve o que o bot deve fazer/dizer.
  -- A IA recebe isso + contexto do trigger + tools disponíveis e gera msg.
  prompt_instruction  TEXT NOT NULL,
  -- Tools que a IA pode usar pra cumprir a regra. NULL = todas as 38.
  -- Limita o que regras podem fazer (regra de "lembrete" não tem delete_*).
  tools_allowed       JSONB,
  -- Cooldown anti-spam (minutos entre disparos do mesmo tipo+target+rep)
  cooldown_minutes    INT NOT NULL DEFAULT 60,
  -- Modelo IA pra essa regra. Default Haiku 4.5 pros alertas curtos
  -- (mais barato), admin pode trocar pra Sonnet em regras complexas.
  ai_model            TEXT DEFAULT 'claude-haiku-4-5-20251001',
  -- Origem: 'system' (pré-configurada na migration/seed, não pode deletar)
  -- ou 'custom' (admin criou via UI, pode deletar)
  source              TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('system', 'custom')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proactive_rules_agent_enabled
  ON assistant_proactive_rules(agent_id, enabled, rule_type);

ALTER TABLE assistant_proactive_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON assistant_proactive_rules;
CREATE POLICY deny_anon_all ON assistant_proactive_rules AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =====================================================
-- 2. assistant_alert_state: cooldowns + dedup de disparos
-- =====================================================
CREATE TABLE IF NOT EXISTS assistant_alert_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  rule_id         UUID NOT NULL REFERENCES assistant_proactive_rules(id) ON DELETE CASCADE,
  -- target = entidade GHL relevante (appointment_id, opportunity_id, task_id etc).
  -- Permite cooldown granular: "não dispara briefing pra MESMO appointment 2x"
  -- enquanto permite "briefings pra appointments DIFERENTES no mesmo dia".
  -- NULL pra alertas sem target específico (resumo matinal etc).
  target_id       TEXT,
  last_fired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Resultado do dispatch (pra histórico no UI)
  -- 'sent' = mandou msg, 'skipped_cooldown', 'skipped_quiet_hours',
  -- 'skipped_disabled', 'failed'
  status          TEXT NOT NULL DEFAULT 'sent',
  -- Tokens consumidos no LLM call (pra rastrear custo por regra)
  tokens_used     INT,
  cost_usd        NUMERIC(10, 6),
  UNIQUE (rep_id, rule_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_alert_state_lookup
  ON assistant_alert_state(rep_id, rule_id, last_fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_state_recent
  ON assistant_alert_state(rule_id, last_fired_at DESC);

ALTER TABLE assistant_alert_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON assistant_alert_state;
CREATE POLICY deny_anon_all ON assistant_alert_state AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);
