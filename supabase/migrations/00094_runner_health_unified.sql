-- Runner health unificada (Pedro 2026-05-28 F17).
--
-- Antes: bulk_runner_health era singleton com last_tick_at do bulk-runner.
-- sequence/recurring/outreach runners não tinham tracking — invisíveis pra
-- hypercare.
--
-- Agora: runner_health (runner_name PK) — 1 row por runner. UI health mostra
-- linha por runner com status individual. bulk-runner-health continua existindo
-- pra backward compat e por já estar populado.
--
-- Aditivo, RLS deny-anon.

CREATE TABLE IF NOT EXISTS runner_health (
  runner_name        TEXT PRIMARY KEY,
  last_tick_at       TIMESTAMPTZ,
  last_duration_ms   INT,
  last_status        TEXT NOT NULL DEFAULT 'ok'
    CHECK (last_status IN ('ok', 'no_op', 'error', 'partial')),
  consecutive_errors INT NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_error_at      TIMESTAMPTZ,
  -- Counters do último tick (interpretação livre por runner).
  last_payload       JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runner_health_status
  ON runner_health(last_status, consecutive_errors)
  WHERE last_status != 'ok';

ALTER TABLE runner_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON runner_health;
CREATE POLICY deny_anon_all ON runner_health AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- Seed rows pros runners conhecidos pra UI mostrar mesmo antes do 1º tick.
INSERT INTO runner_health (runner_name, last_status) VALUES
  ('bulk-runner', 'no_op'),
  ('sequence-runner', 'no_op'),
  ('recurring-runner', 'no_op'),
  ('outreach-runner', 'no_op')
ON CONFLICT (runner_name) DO NOTHING;

COMMENT ON TABLE runner_health IS
  'Pedro 2026-05-28: health por runner (bulk/sequence/recurring/outreach). UI health card mostra row por runner.';
