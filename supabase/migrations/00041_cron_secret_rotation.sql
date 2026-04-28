-- Rotação de CRON_SECRET — remove valor hardcoded em git (C4 review 2026-04-28).
--
-- Antes deste fix, 00032_sparkbot_pg_cron.sql tinha 'Bearer spark-cron-secret-2026'
-- HARDCODED no SQL (commit 753b6a1). Qualquer pessoa com acesso ao repo (ou
-- via git log) podia disparar /api/cron/* manualmente — esses endpoints
-- executam billing, enviam mensagens GHL, etc.
--
-- SETUP MANUAL OBRIGATÓRIO antes de aplicar este migration:
--
--   1. Gerar novo segredo aleatório (32+ chars):
--        openssl rand -hex 32
--
--   2. No Supabase SQL Editor (como superuser/postgres):
--        ALTER DATABASE postgres SET app.cron_secret TO '<novo-valor-hex>';
--      (precisa reconectar pra GUC entrar em vigor — feche/reabra o SQL Editor.)
--
--   3. Adicionar/atualizar a env var no Vercel:
--        CRON_SECRET=<mesmo-valor-hex>
--      Aplicar em todos os 3 envs: Production, Preview, Development.
--
--   4. Aplicar este migration. Os pg_cron jobs agora lerão o secret via
--      current_setting() — fora do código versionado.
--
-- Verificação pós-deploy: `SELECT current_setting('app.cron_secret', false);`
-- deve retornar o valor. Se vazio, GUC não foi configurado.

-- Drop dos jobs antigos (idempotente)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sparkbot-proactive') THEN
    PERFORM cron.unschedule('sparkbot-proactive');
  END IF;
END $$;

-- Recria 'sparkbot-proactive' lendo secret do GUC. Se GUC não foi setado
-- (current_setting retorna NULL com missing_ok=true), o net.http_post recebe
-- 'Bearer null' e o endpoint rejeita. Falha visível imediata > silencioso
-- usar segredo errado.
SELECT cron.schedule(
  'sparkbot-proactive',
  '30 seconds',
  $cron$
  SELECT net.http_post(
    url := 'https://spark-ai-platform.vercel.app/api/cron/sparkbot-proactive',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) WHERE EXISTS (
    SELECT 1 FROM assistant_scheduled_tasks
    WHERE status = 'pending' AND next_run_at <= now()
    LIMIT 1
  )
  OR EXISTS (
    SELECT 1 FROM assistant_proactive_rules
    WHERE rule_type = 'scheduled' AND enabled = true
    LIMIT 1
  );
  $cron$
);

-- Recria 'process-message-queue' (se existir) com mesmo pattern.
-- Migration 00008 deixou comentado; assumimos que foi criado manualmente
-- com o secret hardcoded também. Reagenda só se já existir.
DO $$
DECLARE
  v_url TEXT;
BEGIN
  -- Tenta achar o URL do endpoint atual de process-batch (deduzido do nome
  -- do job antigo). Se não existir, ignora.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-message-queue') THEN
    PERFORM cron.unschedule('process-message-queue');

    PERFORM cron.schedule(
      'process-message-queue',
      '10 seconds',
      $cron2$
      SELECT net.http_post(
        url := 'https://spark-ai-platform.vercel.app/api/agents/process-batch',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || current_setting('app.cron_secret', true),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      ) WHERE EXISTS (
        SELECT 1 FROM message_queue
        WHERE status = 'pending' AND process_after <= now()
        LIMIT 1
      );
      $cron2$
    );
  END IF;
END $$;
