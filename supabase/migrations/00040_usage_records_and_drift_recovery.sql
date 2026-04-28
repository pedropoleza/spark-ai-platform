-- Recuperação de schema drift + bug do UNIQUE NULL em assistant_alert_state
--
-- Contexto (review 2026-04-28):
--   1. usage_records: referenciada por charge.ts e RLS deny_anon (00028) mas
--      NUNCA foi criada via migration. Billing ficou silenciosamente quebrado:
--      INSERT retorna null, branch chargeWallet nunca executa.
--   2. location_settings, agent_feedback, scheduled_followups: usadas em prod
--      mas só existiam no SETUP.sql — clonar repo + aplicar migrations não
--      reproduz o schema. Migration histórica criada agora pra fechar o gap.
--   3. UNIQUE (rep_id, rule_id, target_id) em assistant_alert_state estava
--      sem NULLS NOT DISTINCT. Postgres trata cada NULL como distinct →
--      ON CONFLICT em try_claim_dispatch_slot NUNCA casa rows com target_id
--      NULL. Comentário em 00033:48 ("nosso UNIQUE inclui NULLs como
--      'iguais'") está incorreto. Resultado: claim atômico que essa migration
--      alegava resolver NÃO funciona pra regras globais.
--
-- Estratégia:
--   - IF NOT EXISTS em tudo (idempotente; aplicável em DBs onde tabelas já
--     foram criadas manualmente via SETUP.sql).
--   - DROP + ADD do constraint de assistant_alert_state com NULLS NOT DISTINCT.

-- =============================================================
-- 1. usage_records (C1 — billing)
-- =============================================================
CREATE TABLE IF NOT EXISTS usage_records (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  agent_id           UUID REFERENCES agents(id) ON DELETE SET NULL,
  contact_id         TEXT,
  action_type        TEXT NOT NULL,
  ai_model           TEXT NOT NULL,

  -- Tokens (LLM)
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,

  -- Multi-modal (telemetria pra cobrança correta)
  audio_seconds      NUMERIC(10,2) NOT NULL DEFAULT 0,  -- Whisper $0.006/min
  image_count        INTEGER NOT NULL DEFAULT 0,        -- vision

  -- Custos
  cost_usd           NUMERIC(12,6) NOT NULL DEFAULT 0,
  markup_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
  total_charge_usd   NUMERIC(12,6) NOT NULL DEFAULT 0,

  -- Cobrança
  uses_custom_key    BOOLEAN NOT NULL DEFAULT false,
  charged_to_wallet  BOOLEAN NOT NULL DEFAULT false,
  charged_at         TIMESTAMPTZ,
  ghl_charge_id      TEXT,                              -- idempotency / auditoria

  -- Atomic claim (anti double-charge no batch retry)
  claim_token        UUID,
  claimed_at         TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: dashboard "uso por location"
CREATE INDEX IF NOT EXISTS idx_usage_records_location_created
  ON usage_records(location_id, created_at DESC);

-- Hot path: chargeUnbilledRecords (cron)
CREATE INDEX IF NOT EXISTS idx_usage_records_unbilled
  ON usage_records(created_at)
  WHERE charged_to_wallet = false
    AND uses_custom_key = false
    AND total_charge_usd > 0;

-- Cross-ref auditoria
CREATE INDEX IF NOT EXISTS idx_usage_records_contact
  ON usage_records(location_id, contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON usage_records;
CREATE POLICY deny_anon_all ON usage_records AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =============================================================
-- 2. location_settings (C6 — schema drift)
-- =============================================================
CREATE TABLE IF NOT EXISTS location_settings (
  location_id           TEXT PRIMARY KEY REFERENCES locations(location_id) ON DELETE CASCADE,
  openai_api_key        TEXT,                          -- opcional: BYO key skipa cobrança
  default_timezone      TEXT,
  daily_message_limit   INTEGER,                       -- soft cap (info only por enquanto)
  cost_alert_threshold  NUMERIC(10,2),                 -- alerta quando spend mensal cruza
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE location_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON location_settings;
CREATE POLICY deny_anon_all ON location_settings AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =============================================================
-- 3. agent_feedback (C6 — schema drift)
-- =============================================================
CREATE TABLE IF NOT EXISTS agent_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id     TEXT NOT NULL,
  rating          TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
  ai_message      TEXT NOT NULL,
  user_message    TEXT,
  suggestion      TEXT,
  context         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent_created
  ON agent_feedback(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_location
  ON agent_feedback(location_id, created_at DESC);

ALTER TABLE agent_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON agent_feedback;
CREATE POLICY deny_anon_all ON agent_feedback AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =============================================================
-- 4. scheduled_followups (C6 — schema drift, antes só em SETUP.sql)
-- =============================================================
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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followups_agent_contact
  ON scheduled_followups(agent_id, contact_id, status);
CREATE INDEX IF NOT EXISTS idx_followups_pending
  ON scheduled_followups(status, scheduled_at) WHERE status = 'pending';

ALTER TABLE scheduled_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON scheduled_followups;
CREATE POLICY deny_anon_all ON scheduled_followups AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =============================================================
-- 5. Fix UNIQUE NULL bug em assistant_alert_state (C5)
-- =============================================================
-- O constraint atual é UNIQUE (rep_id, rule_id, target_id) — sem NULLS NOT
-- DISTINCT. Postgres 15+ aceita NULLS NOT DISTINCT que faz NULL = NULL pra
-- esse propósito específico. Se a versão for <15, fazer rebuild do constraint
-- ainda vai falhar; nesse caso fica como TODO e dependemos de NUNCA passar
-- target_id NULL na rpc try_claim_dispatch_slot (que é o caso atual no
-- dispatcher.ts — sempre passa string vazia ou texto).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'assistant_alert_state'::regclass
      AND contype = 'u'
      AND conname LIKE '%target_id%'
  ) THEN
    -- Drop constraint nominado pelo Postgres (não temos garantia do nome exato)
    EXECUTE (
      SELECT 'ALTER TABLE assistant_alert_state DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'assistant_alert_state'::regclass
        AND contype = 'u'
        AND conname LIKE '%target_id%'
      LIMIT 1
    );
  END IF;
END $$;

-- Recria com NULLS NOT DISTINCT — agora ON CONFLICT casa NULL com NULL.
ALTER TABLE assistant_alert_state
  ADD CONSTRAINT assistant_alert_state_dispatch_key
  UNIQUE NULLS NOT DISTINCT (rep_id, rule_id, target_id);

-- =============================================================
-- 6. sparkbot_messages (C2 — Sparkbot real conversation history)
--    Antes deste fix, o webhook real chamava processIncoming SEM
--    conversationHistory → bot era amnésico entre turnos. Synthetic-test
--    funcionava (usa agent_test_messages); produção real não.
-- =============================================================
CREATE TABLE IF NOT EXISTS sparkbot_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL,
  hub_location_id TEXT NOT NULL,
  agent_id        UUID NOT NULL,
  -- Em qual location o rep estava operando quando mandou a msg
  active_location_id TEXT,
  role            TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  content         TEXT NOT NULL,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: ler N msgs mais recentes do rep no webhook handler
CREATE INDEX IF NOT EXISTS idx_sparkbot_messages_rep_recent
  ON sparkbot_messages(rep_id, hub_location_id, created_at DESC);

-- TTL: cron de cleanup remove >30d (a ser adicionado em 00034 ou cron novo)
CREATE INDEX IF NOT EXISTS idx_sparkbot_messages_old
  ON sparkbot_messages(created_at)
  WHERE created_at < now() - interval '30 days';

ALTER TABLE sparkbot_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON sparkbot_messages;
CREATE POLICY deny_anon_all ON sparkbot_messages AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =============================================================
-- 7. trigger touch_updated_at em location_settings
-- =============================================================
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_location_settings_updated ON location_settings;
CREATE TRIGGER trg_location_settings_updated
  BEFORE UPDATE ON location_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_scheduled_followups_updated ON scheduled_followups;
CREATE TRIGGER trg_scheduled_followups_updated
  BEFORE UPDATE ON scheduled_followups
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
