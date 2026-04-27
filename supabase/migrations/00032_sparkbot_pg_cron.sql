-- Sparkbot V2.1 — pg_cron job pra triggers proativos.
--
-- Substitui o Vercel Cron (que era limitado a 1x/dia no plano Hobby).
-- Reusa o mesmo padrão do `process-message-queue` job: net.http_post a
-- cada 30s com conditional fire (só dispara se houver work pendente).
--
-- Este SQL é executado MANUALMENTE no Supabase Dashboard / via MCP, igual
-- a migration 00008. pg_cron + pg_net já estão habilitados no projeto.
--
-- Pra remover:
--   SELECT cron.unschedule('sparkbot-proactive');
--
-- Pra ver execuções:
--   SELECT * FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'sparkbot-proactive')
--   ORDER BY start_time DESC LIMIT 20;

-- Idempotente: drop antes de recriar (cron.schedule não tem ON CONFLICT)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sparkbot-proactive') THEN
    PERFORM cron.unschedule('sparkbot-proactive');
  END IF;
END $$;

SELECT cron.schedule(
  'sparkbot-proactive',
  '30 seconds',
  $cron$
  SELECT net.http_post(
    url := 'https://spark-ai-platform.vercel.app/api/cron/sparkbot-proactive',
    headers := '{"Authorization": "Bearer spark-cron-secret-2026", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) WHERE EXISTS (
    -- Reminders devidos (one-shot ou recurring)
    SELECT 1 FROM assistant_scheduled_tasks
    WHERE status = 'pending' AND next_run_at <= now()
    LIMIT 1
  )
  OR EXISTS (
    -- Regras scheduled enabled (cron evaluator decide se é a hora)
    SELECT 1 FROM assistant_proactive_rules
    WHERE rule_type = 'scheduled' AND enabled = true
    LIMIT 1
  );
  $cron$
);
