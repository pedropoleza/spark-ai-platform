-- 00120 — Correções de review adversarial do rep_notes (F1, review 2026-07-02)
--
-- 3 achados CONFIRMED do review (LGPD/retenção):
-- (1) purge_old_rep_notes: a 2ª condição não filtrava deleted_at IS NULL → uma
--     nota soft-deletada há POUCO mas criada há >12m era hard-deletada na hora
--     (perdia o grace de 30 dias). Agora as 2 regras são independentes:
--       soft-deletada > 30d  OU  (ativa E criada > 12m).
-- (2) faltava GRANT EXECUTE pra service_role (padrão do projeto) → pg_cron não
--     conseguiria chamar a função.
-- (3) a purga nunca foi plugada no cron (00034 declarava a intenção mas não
--     chamava) → a retenção de 12m NUNCA rodaria. Re-agenda o 'sparkbot-cleanup'
--     incluindo a chamada.
-- Idempotente (CREATE OR REPLACE + unschedule/schedule).

CREATE OR REPLACE FUNCTION purge_old_rep_notes()
RETURNS INTEGER AS $$
DECLARE
  n INTEGER;
BEGIN
  WITH del AS (
    DELETE FROM rep_notes
    WHERE (deleted_at IS NOT NULL AND deleted_at < now() - INTERVAL '30 days')
       OR (deleted_at IS NULL     AND created_at < now() - INTERVAL '12 months')
    RETURNING 1
  )
  SELECT count(*) INTO n FROM del;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION purge_old_rep_notes() TO service_role;

-- Re-agenda o cleanup diário incluindo a purga de rep_notes (retenção 12m LGPD).
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

  SELECT purge_old_rep_notes();
  $cleanup$
);
