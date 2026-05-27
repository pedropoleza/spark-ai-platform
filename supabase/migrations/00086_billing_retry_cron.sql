-- =============================================================================
-- Migration 00086: pg_cron dedicado pro retry de cobrança ('billing-retry')
-- C3-1 / C3-2 / P0-3 (ultra-review 2026-05-26).
--
-- Motivação:
--   `chargeUnbilledRecords` (retry de cobrança do wallet GHL) só tinha UM
--   scheduler: o Vercel cron `process-queue` (0 0 * * *, 1×/dia), rodando dentro
--   de um Promise.all de 4 jobs pesados que disputam o orçamento de 60s da
--   lambda. O pg_cron — scheduler confiável pra onde migramos os outros jobs
--   (Hobby limita Vercel crons) — NUNCA chamava billing. Resultado: o retry
--   praticamente não rodava e o backlog de unbilled encalhou (em 2026-05-21,
--   192 records reivindicados num run que morreu antes de liberar → órfãos pra
--   sempre; ~$16 não cobrados, oldest 2026-05-05).
--
--   Esta migration dá ao billing-retry o MESMO tratamento dos outros jobs: um
--   endpoint isolado (/api/cron/billing-retry) chamado a cada 5min, com os 60s
--   inteiros. O endpoint roda o reaper de claims órfãos (>15min) + cobra um
--   batch bounded. Guard WHERE EXISTS: só dispara o http_post se há unbilled —
--   evita auto-DDoS de calls vazias (mesmo padrão do sparkbot-proactive).
--
--   Idempotência: claim_token impede 2 runs pegarem o mesmo record; eventId
--   (=usage_record.id) impede o GHL cobrar 2x. Overlap de runs é seguro. Como
--   maxDuration=60s < 5min, na prática não há overlap.
--
--   Reusa public.cron_config (base_url + proactive_secret) da migration 00070 —
--   em PROD resolve pra mesma URL/secret dos outros jobs. O secret tem que bater
--   com CRON_SECRET do Vercel (isAuthorizedCron valida Bearer constante-time).
--
-- ⚠️ APLICAR COM SUPERVISÃO: cria um job CONTÍNUO (a cada 5min) que cobra dinheiro
--   real do wallet das sub-accounts. Após aplicar:
--     1. SELECT jobid, schedule, active FROM cron.job WHERE jobname='billing-retry';
--     2. Acompanhar logs do Vercel: `[cron:billing-retry] charged=.. reaped=..`.
--     3. Conferir que o backlog drena (unbilled cai) sem double-charge.
--   Em staging/fork: dar UPDATE em cron_config.base_url pro domínio certo, senão
--   chama a PROD.
-- =============================================================================

-- Recria idempotente: remove versão anterior se existir, depois agenda.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'billing-retry') THEN
    PERFORM cron.unschedule('billing-retry');
  END IF;
END $$;

SELECT cron.schedule(
  'billing-retry',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := (SELECT base_url || '/api/cron/billing-retry' FROM public.cron_config WHERE id = 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT proactive_secret FROM public.cron_config WHERE id = 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  WHERE EXISTS (
    SELECT 1 FROM public.usage_records
    WHERE charged_to_wallet = false
      AND uses_custom_key = false
      AND cap_blocked = false
      AND total_charge_usd > 0
    LIMIT 1
  );
  $cron$
);
