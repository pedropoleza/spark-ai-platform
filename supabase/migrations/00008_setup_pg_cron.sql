-- Habilitar extensoes para debounce automatico
-- NOTA: Execute manualmente no Supabase Dashboard > SQL Editor
-- pois pg_cron e pg_net precisam de permissoes especiais

-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net;

-- Agendar processamento da fila a cada 10 segundos
-- Substitua YOUR_APP_URL pela URL do seu app no Vercel
-- Substitua YOUR_CRON_SECRET pelo valor da env CRON_SECRET

-- SELECT cron.schedule(
--   'process-message-queue',
--   '10 seconds',
--   $$
--   SELECT net.http_post(
--     url := 'https://YOUR_APP_URL/api/agents/process-batch',
--     headers := '{"Authorization": "Bearer YOUR_CRON_SECRET", "Content-Type": "application/json"}'::jsonb,
--     body := '{}'::jsonb
--   ) WHERE EXISTS (
--     SELECT 1 FROM message_queue
--     WHERE status = 'pending' AND process_after <= now()
--     LIMIT 1
--   );
--   $$
-- );

-- Para verificar cron jobs ativos:
-- SELECT * FROM cron.job;

-- Para remover o job:
-- SELECT cron.unschedule('process-message-queue');
