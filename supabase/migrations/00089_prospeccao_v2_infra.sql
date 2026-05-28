-- Prospecção 2.0 — infraestrutura completa (Pedro 2026-05-28).
-- _planning/_gaps-prospeccao-2026-05-28/PLANO.md §6 (Etapas 4.3 a 4.8)
--
-- Cria as 4 tabelas + 2 colunas necessárias pra runner outreach, sequência
-- multi-toque, recorrência, segmentos dinâmicos, A/B e opt-outs.
-- UI completa pra cada feature vem em iterações futuras; runtime FICA gated
-- via flags (OUTREACH_RUNNER_ENABLED, RECURRING_CAMPAIGNS_ENABLED default OFF)
-- pra zero impacto até admin ligar conscientemente.
--
-- Tudo aditivo, RLS deny-anon, indexes pra cron-friendly queries.

-- =====================================================
-- 1. outreach_runs — histórico de execuções do runner
-- =====================================================
CREATE TABLE IF NOT EXISTS outreach_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL,
  -- Cooldown: 1 run por dia por agente (anti-flood se cron acelerar).
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Snapshot do que foi feito.
  contacts_targeted INT NOT NULL DEFAULT 0,
  contacts_enqueued INT NOT NULL DEFAULT 0,
  bulk_job_id   UUID REFERENCES bulk_message_jobs(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'skipped_no_contacts', 'skipped_cooldown', 'skipped_outside_hours', 'failed')),
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_runs_agent_recent
  ON outreach_runs(agent_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_runs_location
  ON outreach_runs(location_id, ran_at DESC);

ALTER TABLE outreach_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON outreach_runs;
CREATE POLICY deny_anon_all ON outreach_runs AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

COMMENT ON TABLE outreach_runs IS
  'Pedro 2026-05-28: histórico de execuções do outreach-runner. Cooldown 24h por agente.';

-- =====================================================
-- 2. bulk_message_sequences — definição da sequência multi-toque
-- =====================================================
-- Linha por step da sequência. job_id é o "job-mãe"; cada step vira novo
-- job filho na hora de disparar (ou inline — runner decide).
CREATE TABLE IF NOT EXISTS bulk_message_sequences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES bulk_message_jobs(id) ON DELETE CASCADE,
  step_number     INT NOT NULL CHECK (step_number >= 1 AND step_number <= 10),
  template        TEXT NOT NULL,
  -- Delay em dias após o step anterior (ou após início pro step 1).
  delay_days      INT NOT NULL DEFAULT 0 CHECK (delay_days >= 0 AND delay_days <= 90),
  -- Se true, pausa o contato na sequência se ele respondeu desde o step anterior.
  pause_on_reply  BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_bulk_seq_job ON bulk_message_sequences(job_id, step_number);

ALTER TABLE bulk_message_sequences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON bulk_message_sequences;
CREATE POLICY deny_anon_all ON bulk_message_sequences AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =====================================================
-- 3. bulk_message_sequence_state — estado por contato na sequência
-- =====================================================
CREATE TABLE IF NOT EXISTS bulk_message_sequence_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    UUID NOT NULL REFERENCES bulk_message_recipients(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES bulk_message_jobs(id) ON DELETE CASCADE,
  current_step    INT NOT NULL DEFAULT 1,
  next_send_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused_by_reply', 'completed', 'cancelled')),
  paused_at       TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_bulk_seq_state_due
  ON bulk_message_sequence_state(next_send_at, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_bulk_seq_state_job
  ON bulk_message_sequence_state(job_id, status);

ALTER TABLE bulk_message_sequence_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON bulk_message_sequence_state;
CREATE POLICY deny_anon_all ON bulk_message_sequence_state AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =====================================================
-- 4. recurring_campaigns — campanhas que rodam em cron
-- =====================================================
CREATE TABLE IF NOT EXISTS recurring_campaigns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id                   UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id              TEXT NOT NULL,
  agent_id                 UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label                    TEXT NOT NULL,
  -- "0 9 * * 1" = toda 2ª às 9am. Pega via lib node-cron / fixe via JS.
  cron_expression          TEXT NOT NULL,
  timezone                 TEXT NOT NULL DEFAULT 'America/New_York',
  -- Snapshot do FEL filter — refresh_segment_on_run controla se re-executa.
  filter_config            JSONB NOT NULL,
  message_template         TEXT NOT NULL,
  delivery_channel         TEXT NOT NULL DEFAULT 'whatsapp_web_sms'
    CHECK (delivery_channel IN ('whatsapp_web_sms', 'whatsapp_api')),
  -- Etapa 4.6: re-executa o FEL filter a cada disparo (vs snapshot).
  refresh_segment_on_run   BOOLEAN NOT NULL DEFAULT true,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  -- Cron tick: setado pelo runner após cada disparo.
  last_run_at              TIMESTAMPTZ,
  next_run_at              TIMESTAMPTZ,
  -- Hard cap absoluto por execução (proteção anti-spam).
  per_run_cap              INT NOT NULL DEFAULT 1000 CHECK (per_run_cap >= 1 AND per_run_cap <= 50000),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recurring_due
  ON recurring_campaigns(next_run_at) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_recurring_location
  ON recurring_campaigns(location_id, enabled);

ALTER TABLE recurring_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON recurring_campaigns;
CREATE POLICY deny_anon_all ON recurring_campaigns AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =====================================================
-- 5. outreach_optouts — contatos opted-out (whitelist/blacklist)
-- =====================================================
CREATE TABLE IF NOT EXISTS outreach_optouts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  TEXT NOT NULL,
  contact_id   TEXT NOT NULL,
  -- 'keyword' = lead respondeu STOP/PARAR/etc. 'manual' = admin adicionou.
  source       TEXT NOT NULL DEFAULT 'keyword'
    CHECK (source IN ('keyword', 'manual', 'webhook')),
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_optouts_location_contact
  ON outreach_optouts(location_id, contact_id);

ALTER TABLE outreach_optouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON outreach_optouts;
CREATE POLICY deny_anon_all ON outreach_optouts AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

COMMENT ON TABLE outreach_optouts IS
  'Pedro 2026-05-28: opt-outs por contact_id. Runner consulta antes de enviar.';

-- =====================================================
-- 6. Estende bulk_message_jobs com A/B variants
-- =====================================================
-- ab_variants JSONB: [{ template, weight }]. NULL = sem A/B (template único
-- em message_template segue válido). Runner sorteia por weight no dispatch.
ALTER TABLE bulk_message_jobs
  ADD COLUMN IF NOT EXISTS ab_variants JSONB;

-- variant_id em recipients pra stats por variante.
ALTER TABLE bulk_message_recipients
  ADD COLUMN IF NOT EXISTS variant_id INT;

CREATE INDEX IF NOT EXISTS idx_bulk_recipients_variant
  ON bulk_message_recipients(job_id, variant_id) WHERE variant_id IS NOT NULL;
