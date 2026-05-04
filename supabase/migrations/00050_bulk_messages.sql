-- =============================================
-- 00050_bulk_messages
--
-- Pedro 2026-05-04: tool de disparo em massa com drip mode pro SparkBot.
-- Permite "manda msg pra todos com tag X" sem queimar WhatsApp do rep.
--
-- Arquitetura:
--   - bulk_message_jobs: header de disparo. 1 row por broadcast iniciado.
--   - bulk_message_recipients: 1 row por contato. Calcula scheduled_at
--     no momento do create (drip + jitter). Cron processa pending.
--
-- Drip config: interval_seconds (default 90s) ± jitter_seconds (default
-- 30s) entre msgs. Pra 100 contatos a 90s = ~2h30 de envio total.
--
-- Cap: agent_configs.daily_bulk_message_cap (default 100/dia/location).
-- Conta TODAS as msgs enfileiradas/enviadas nas últimas 24h. Se passar,
-- a tool schedule_bulk_message rejeita.
--
-- Variação: variation_mode ('none'/'light'/'medium'). 'light' default
-- usa Haiku 4.5 pra rewrite leve por contato — pra parecer mais natural
-- e evitar pattern detection do WhatsApp.
--
-- Anti-ban guards no runner:
--   - quiet_hours respeitado (não envia 22h-7h por default)
--   - silence_gate NÃO se aplica (msg é pra contato, não pro rep)
--   - status='paused' bloqueia processamento até resume
-- =============================================

-- Header: 1 row por disparo
CREATE TABLE IF NOT EXISTS bulk_message_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id text NOT NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,

  -- Filtro usado (jsonb pra evoluir). Hoje suporta `{ tag: "Direct Agent" }`.
  -- Futuro: contact_ids: [...], pipeline_stage: ..., etc.
  filter_config jsonb NOT NULL,

  -- Mensagem base + variação
  message_template text NOT NULL,
  variation_mode text NOT NULL DEFAULT 'light'
    CHECK (variation_mode IN ('none','light','medium')),

  -- Drip config
  interval_seconds integer NOT NULL DEFAULT 90
    CHECK (interval_seconds >= 30 AND interval_seconds <= 600),
  jitter_seconds integer NOT NULL DEFAULT 30
    CHECK (jitter_seconds >= 0 AND jitter_seconds <= 120),

  -- Canal de envio (rename Pedro 2026-05-04: SMS=WhatsApp Web/SMS via Stevo,
  -- WhatsApp=WhatsApp API oficial)
  delivery_channel text NOT NULL DEFAULT 'whatsapp_web_sms'
    CHECK (delivery_channel IN ('whatsapp_web_sms','whatsapp_api')),

  -- Quiet hours honring (snapshot do agent_configs.quiet_hours no create)
  respect_quiet_hours boolean NOT NULL DEFAULT true,

  -- Status + counters atualizados pelo runner
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','paused','completed','cancelled','failed')),
  total_contacts integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,

  start_at timestamptz NOT NULL DEFAULT now(),
  estimated_completion_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_rep_status
  ON bulk_message_jobs(rep_id, status);
CREATE INDEX IF NOT EXISTS idx_bulk_jobs_location_created
  ON bulk_message_jobs(location_id, created_at DESC);

-- Recipients: 1 row por contato target
CREATE TABLE IF NOT EXISTS bulk_message_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES bulk_message_jobs(id) ON DELETE CASCADE,
  contact_id text NOT NULL,
  contact_name text,
  contact_phone text,

  -- Calculado no create (start_at + i * interval ± jitter)
  scheduled_at timestamptz NOT NULL,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','skipped','cancelled')),

  -- Versão final enviada (após variação) — null antes do dispatch
  actual_message text,

  sent_at timestamptz,
  error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- 1 contato só pode aparecer 1x por job (anti-duplicate)
  UNIQUE (job_id, contact_id)
);

-- Index pro runner pegar batch a cada tick:
-- WHERE status='pending' AND scheduled_at <= now()
CREATE INDEX IF NOT EXISTS idx_bulk_recipients_due
  ON bulk_message_recipients(scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_bulk_recipients_job_status
  ON bulk_message_recipients(job_id, status);

-- Cap diário em agent_configs
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS daily_bulk_message_cap integer DEFAULT 100;

COMMENT ON COLUMN agent_configs.daily_bulk_message_cap IS
  'Max msgs em massa que o SparkBot pode enfileirar pra esta location em 24h. Default 100. NULL = sem cap. Tool schedule_bulk_message rejeita se passar.';

COMMENT ON TABLE bulk_message_jobs IS
  'Header de disparo em massa do SparkBot. 1 row por broadcast iniciado pela tool schedule_bulk_message.';
COMMENT ON TABLE bulk_message_recipients IS
  '1 row por contato destinatário de um bulk_message_job. scheduled_at calculado no create com drip + jitter pra parecer envio humano.';
