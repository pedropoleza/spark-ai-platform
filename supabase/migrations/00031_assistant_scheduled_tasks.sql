-- Account Assistant V2.1 — Scheduled tasks (lembretes do rep).
--
-- Quando o rep diz "me lembra amanhã 10h" ou "todo dia 18h me manda os
-- fechamentos", o Sparkbot agenda uma entrada nesta tabela. O cron processa
-- next_run_at <= now() e dispara via assistant_test_messages (V2 simulated)
-- ou WhatsApp Hub (V3).

CREATE TABLE IF NOT EXISTS assistant_scheduled_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id     TEXT NOT NULL,
  -- 'reminder' = one-shot (cron_expr null), dispara 1x e fica completed
  -- 'recurring_reminder' = cron, recompila next_run_at após cada disparo
  task_type       TEXT NOT NULL CHECK (task_type IN ('reminder', 'recurring_reminder')),
  -- { message: string, title?: string, source: 'rep_request', test_session_id?: string }
  task_payload    JSONB NOT NULL,
  next_run_at     TIMESTAMPTZ NOT NULL,
  -- null = one-shot. Quando preenchido, runner recalcula next_run_at após cada disparo.
  cron_expr       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index parcial: cron query é "WHERE status='pending' AND next_run_at <= now()"
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
  ON assistant_scheduled_tasks(next_run_at)
  WHERE status = 'pending';

-- Index pra list_my_reminders (lista por rep)
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_rep
  ON assistant_scheduled_tasks(rep_id, status, next_run_at);

ALTER TABLE assistant_scheduled_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON assistant_scheduled_tasks;
CREATE POLICY deny_anon_all ON assistant_scheduled_tasks AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);
