-- Sparkbot V2.2 — pg_cron diário pra limpar dados antigos.
--
-- assistant_scheduled_tasks cresce com cada reminder one-shot disparado.
-- assistant_alert_state cresce com cada disparo de regra. Sem cleanup,
-- as tabelas ficam infladas em meses, query plans degradam.
--
-- Política:
--   - tasks completed/cancelled/failed >30 dias → DELETE (não tem valor)
--   - alerts disparados >90 dias → DELETE (histórico vira ruído pro debug)
--
-- Idempotente — drop+recreate.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sparkbot-cleanup') THEN
    PERFORM cron.unschedule('sparkbot-cleanup');
  END IF;
END $$;

SELECT cron.schedule(
  'sparkbot-cleanup',
  '0 3 * * *',
  $cleanup$
  DELETE FROM assistant_scheduled_tasks
  WHERE status IN ('completed', 'cancelled', 'failed')
    AND COALESCE(last_run_at, created_at) < now() - interval '30 days';

  DELETE FROM assistant_alert_state
  WHERE last_fired_at < now() - interval '90 days';
  $cleanup$
);
