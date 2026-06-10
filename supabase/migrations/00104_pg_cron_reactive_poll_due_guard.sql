-- =============================================================================
-- Migration 00104: guard do pg_cron 'sparkbot-proactive' gateia reactive por
-- poll-due (não mais "enabled = true" sempre-verdadeiro). H39 (Pedro 2026-06-10).
-- Depende da 00103 (coluna reactive_last_polled_at).
--
-- Motivação:
--   O guard das 00053/00070 tinha 3 EXISTS no OR. O do meio —
--     EXISTS (assistant_proactive_rules WHERE enabled = true)
--   — era SEMPRE verdadeiro em prod, porque post_meeting (reactive) e Resumo
--   matinal (scheduled) ficam enabled permanentemente. Resultado: o endpoint
--   disparava a cada 30s incondicionalmente; o "auto-DDoS removido" prometido
--   no header das 00053/00070 NÃO valia pra esse ramo (cada tick rodava o
--   polling GHL do post_meeting → ~51k calls/dia à toa, pressão de rate-limit).
--
--   Fix (semântica que NÃO quebra post_meeting NEM Resumo matinal):
--     - scheduled: continua "sempre acorda" — shouldFireCron casa o MINUTO
--       exato no tz do rep, então o endpoint PRECISA acordar a cada ~30s pra
--       não perder o minuto. Throttlar quebraria o Resumo matinal. (Reduzir
--       essa frequência exigiria precomputar next_run_at por rep — fora de
--       escopo; follow-up.)
--     - reactive: só acorda quando poll-due (reactive_last_polled_at <= now()
--       - 5min). O grace de 30min do post_meeting cobre folgado. O endpoint
--       carimba reactive_last_polled_at via claim atômico (route.ts). DEVE
--       ficar em sync com REACTIVE_POLL_INTERVAL_MS (5min) no route.ts.
--
--   Em prod, com Resumo matinal enabled, o ramo scheduled ainda acorda a cada
--   30s — a economia REAL de calls GHL vem do THROTTLE no endpoint (route.ts),
--   não deste guard. Aqui o ganho é o guard ficar honesto (post_meeting sozinho
--   não mantém o cron quente) + defesa-em-profundidade pra configs reactive-only
--   (sub-account/futuro sem rule scheduled): aí sim o endpoint dorme entre polls.
--
-- ⚠️⚠️ APLICAR COM SUPERVISÃO (smoke) — RECRIA o job 'sparkbot-proactive',
-- operação CONTÍNUA (a cada 30s: reminders, bulk, proativos). Após aplicar:
--   1. SELECT active, command FROM cron.job WHERE jobname='sparkbot-proactive';
--   2. confirmar que reminder/bulk/post_meeting voltaram a disparar (logs).
-- Em staging/fork: dar UPDATE em cron_config.base_url pro domínio correto após
-- aplicar (senão continua chamando prod, igual ao aviso da 00070).
-- =============================================================================

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
    OR EXISTS (SELECT 1 FROM bulk_message_recipients
               WHERE status = 'pending' AND scheduled_at <= now() LIMIT 1)
    -- scheduled: wake minute-precision (não throttlável — ver header).
    OR EXISTS (SELECT 1 FROM assistant_proactive_rules
               WHERE enabled = true AND rule_type = 'scheduled' LIMIT 1)
    -- reactive: só quando poll-due (>5min desde a última poll). Em sync com
    -- REACTIVE_POLL_INTERVAL_MS no route.ts.
    OR EXISTS (SELECT 1 FROM assistant_proactive_rules
               WHERE enabled = true AND rule_type = 'reactive'
                 AND reactive_last_polled_at <= now() - interval '5 minutes'
               LIMIT 1)
  );
  $cron$
);
