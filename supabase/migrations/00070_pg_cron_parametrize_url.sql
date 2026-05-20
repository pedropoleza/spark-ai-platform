-- =============================================================================
-- Migration 00070: parametriza URL + secret do pg_cron 'sparkbot-proactive'
-- V2.2 da refatoração (2026-05-20). Ref: B1-arquitetura.md §6.
--
-- Motivação:
--   O command do cron 'sparkbot-proactive' (migration 00053) tinha a URL
--   'https://spark-ai-platform.vercel.app/...' e o secret HARDCODED. Resultado:
--   qualquer fresh branch / staging que rodasse as migrations agendava um cron
--   apontando pra PROD (auto-trigger cruzado). Esta migration move url+secret
--   pra uma tabela singleton `cron_config` e recria o job lendo dela.
--   Em PROD resolve pra MESMA URL → comportamento IDÊNTICO.
--
-- ⚠️⚠️ APLICAR COM SUPERVISÃO (smoke) — NÃO foi aplicada via MCP na sessão
-- noturna (dono away). Esta migration RECRIA o job 'sparkbot-proactive', que é
-- uma operação CONTÍNUA (a cada 30s: reminders, bulk, proativos). Após aplicar:
--   1. confirmar `SELECT active, command FROM cron.job WHERE jobname='sparkbot-proactive'`
--   2. confirmar que o proativo voltou a disparar (logs / um reminder de teste).
-- Em staging/fork: após aplicar, dar UPDATE em cron_config.base_url pro domínio
-- correto (senão continua chamando prod).
--
-- TODO(futuro): mover proactive_secret pra Vault/env em vez de tabela.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cron_config (
  id                int         PRIMARY KEY DEFAULT 1,
  base_url          text        NOT NULL,
  proactive_secret  text        NOT NULL,
  updated_at        timestamptz DEFAULT now(),
  CONSTRAINT cron_config_singleton CHECK (id = 1)
);

-- Valores de PROD (mantém o status quo da 00053). Idempotente.
INSERT INTO public.cron_config (id, base_url, proactive_secret)
VALUES (
  1,
  'https://spark-ai-platform.vercel.app',
  'ea1b466279335e9ca9e7b7c17582b33b637c77b4b9fa8b1e9ef9152c03b44d8d'
)
ON CONFLICT (id) DO NOTHING;

-- Recria o job lendo url+secret da cron_config. Guards (advisory lock + triplo
-- EXISTS) PRESERVADOS idênticos à 00053 — só a url/header viram parametrizados.
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
    url := (SELECT base_url || '/api/cron/sparkbot-proactive' FROM public.cron_config WHERE id = 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT proactive_secret FROM public.cron_config WHERE id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  WHERE pg_try_advisory_xact_lock(8675309)
  AND (
    EXISTS (SELECT 1 FROM assistant_scheduled_tasks
            WHERE status = 'pending' AND next_run_at <= now() LIMIT 1)
    OR EXISTS (SELECT 1 FROM assistant_proactive_rules
               WHERE enabled = true LIMIT 1)
    OR EXISTS (SELECT 1 FROM bulk_message_recipients
               WHERE status = 'pending' AND scheduled_at <= now() LIMIT 1)
  );
  $cron$
);
