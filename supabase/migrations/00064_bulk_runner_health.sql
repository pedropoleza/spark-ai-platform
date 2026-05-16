-- =====================================================================
-- 00064 — Bulk Runner Health (F1.5 do plano bulk-management-platform).
-- =====================================================================
-- Pedro 2026-05-16 (caso Gustavo): bulk-message-runner travou silenciosamente
-- entre 2026-05-15 23:23 e 2026-05-16 20:20 — 21h com 63 recipients pending
-- e 0 sent em 3 jobs running, sem nenhum alert. Rep só percebeu quando
-- perguntou "Você está funcionando?".
--
-- Esta migration adiciona:
-- 1. Singleton table `bulk_runner_health` — registra last_tick_at do runner.
-- 2. View `bulk_runner_stale` — true se last_tick_at > 5min atrás.
--
-- O runner (proactive/bulk-message-runner.ts) faz upsert em todo tick.
-- Cron de monitoramento (/api/cron/* ou interno) faz polling da view e
-- cria admin signal se stale=true.

CREATE TABLE IF NOT EXISTS bulk_runner_health (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_jobs_processed INT DEFAULT 0,
  last_fired INT DEFAULT 0,
  last_failed INT DEFAULT 0,
  last_skipped INT DEFAULT 0,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  consecutive_errors INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed singleton row
INSERT INTO bulk_runner_health (id, last_tick_at)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE bulk_runner_health IS
  'Singleton (id=1) que registra heartbeat do bulk-message-runner. Cron monitora pra detectar runner travado. Pedro 2026-05-16 caso Gustavo.';

-- View pra detectar runner stale (>5min sem tick)
CREATE OR REPLACE VIEW bulk_runner_stale_v AS
SELECT
  id,
  last_tick_at,
  EXTRACT(EPOCH FROM (now() - last_tick_at))::INT AS seconds_since_last_tick,
  (now() - last_tick_at > interval '5 minutes') AS is_stale,
  consecutive_errors,
  last_error,
  last_error_at
FROM bulk_runner_health
WHERE id = 1;

COMMENT ON VIEW bulk_runner_stale_v IS
  'Status do bulk runner. is_stale=true se >5min sem tick. Cron consome.';
