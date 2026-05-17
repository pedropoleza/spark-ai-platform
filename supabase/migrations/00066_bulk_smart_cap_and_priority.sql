-- =====================================================================
-- 00066 — Bulk Smart Cap + Priority Queue (Fases 3 e 4 do plano).
-- =====================================================================
-- Pedro 2026-05-16: dado um sistema multi-job estável, agora adicionamos
-- inteligência:
--   F3.1 default cap 100 → 300 (aplicado em código getDailyCap, não DB)
--   F3.2 per-contact cooldown WARN (não bloqueia, só avisa no preview)
--   F3.4 weekly cap secundário (opcional, configurável)
--   F4.1 priority queue (runner ordena por priority desc)
--   F4.2 job labels human-friendly (rep nomeia)
--
-- Mudanças schema:
-- 1. Nova table `bulk_contact_cooldown` — rastreia últimas msgs bulk por contato
-- 2. Colunas novas em `bulk_message_jobs`: priority, label
-- 3. Coluna nova em `agent_configs`: weekly_bulk_message_cap

-- =====================================================================
-- bulk_contact_cooldown
-- =====================================================================
-- Registra a última vez que cada contato recebeu msg bulk. Runner faz
-- UPSERT após cada send. Preview consulta antes de mostrar pro rep.
-- PK composta (contact_id, location_id) garante 1 row por par.

CREATE TABLE IF NOT EXISTS bulk_contact_cooldown (
  contact_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL,
  job_id UUID REFERENCES bulk_message_jobs(id) ON DELETE SET NULL,
  send_count_30d INT DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (contact_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_bulk_contact_cooldown_last_sent
  ON bulk_contact_cooldown (location_id, last_sent_at DESC);

COMMENT ON TABLE bulk_contact_cooldown IS
  'Pedro 2026-05-16 F3.2: rastreia ultima msg bulk por contato. Preview ' ||
  'consulta pra avisar duplicacao recente. NAO bloqueia schedule.';

-- =====================================================================
-- bulk_message_jobs — priority + label
-- =====================================================================

ALTER TABLE bulk_message_jobs
  ADD COLUMN IF NOT EXISTS priority INT DEFAULT 50,
  ADD COLUMN IF NOT EXISTS label TEXT;

CREATE INDEX IF NOT EXISTS idx_bulk_message_jobs_priority_status
  ON bulk_message_jobs (priority DESC, status) WHERE status = 'running';

COMMENT ON COLUMN bulk_message_jobs.priority IS
  'F4.1: 1-100. Runner processa por priority desc, scheduled_at asc. Default 50.';
COMMENT ON COLUMN bulk_message_jobs.label IS
  'F4.2: nome humano do job (ex: "M3 terça", "Black Friday lead"). Dashboard usa.';

-- =====================================================================
-- agent_configs — weekly cap secundário
-- =====================================================================

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS weekly_bulk_message_cap INT;

COMMENT ON COLUMN agent_configs.weekly_bulk_message_cap IS
  'F3.4: cap secundario rolling 7 days. NULL = sem cap semanal (so o diario). ' ||
  'Quando setado, schedule_bulk_message_v2 checa antes de criar job.';
