-- =============================================
-- 00053_cron_guards_advisory_lock
--
-- Pedro 2026-05-05 (ULTRA-REVIEW Track 6 H3 + Track 12 C1): re-cria
-- pg_cron sparkbot-proactive com:
--   1. WHERE EXISTS guard que faltava pós-00041 (auto-DDoS removido).
--      Antes: cron disparava 30s no vazio = 2880 calls/dia desnecessárias.
--   2. pg_try_advisory_xact_lock(8675309) anti double-execution sob backlog.
--      Sob spike, 2+ ticks paralelos podiam concorrer pelas mesmas rows.
--      ⚠️ ESSA JUSTIFICATIVA ESTÁ ERRADA — ver CORREÇÃO 2026-06-10 no fim do header.
--   3. Inclui bulk_message_recipients no EXISTS pra cobrir bulk-only jobs.
--
-- Mantém secret hardcoded (rotação via GUC fica pra runbook manual —
-- requires ALTER DATABASE permission).
--
-- ⚠️ CORREÇÃO 2026-06-10 (ver NB-7 em docs/DECISIONS.md): o item (2) acima
-- SUPERESTIMA o advisory lock. NÃO mexer no corpo (migration já aplicada) — só
-- esta nota corretiva. O lock é xact-scoped e `net.http_post` (pg_net) é
-- ASSÍNCRONO: este comando só ENFILEIRA o POST e a transação do pg_cron commita
-- (soltando o lock) em ms, ANTES do Vercel receber o request. Logo o lock NÃO
-- serializa as execuções reais do endpoint /api/cron/sparkbot-proactive nem dos
-- runners internos; só evita que duas transações de DISPARO do MESMO instante
-- co-enfileirem (cenário ~impossível no schedule de 30s). A idempotência real
-- (anti double-execution sob ticks sobrepostos — maxDuration=60 > 30s) é o claim
-- atômico CAS por linha DENTRO de cada runner: fireScheduledReminders (UPDATE
-- status='running' WHERE status='pending') e claimBulkRecipients (RPC
-- claim_bulk_recipients FOR UPDATE SKIP LOCKED / fallback UPDATE status='sending'
-- WHERE status='pending'). O lock fica como guard barato (não faz mal), mas NÃO
-- é o que previne double-execution — não remover os claims confiando nele.
-- =============================================

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
    headers := '{"Authorization": "Bearer ea1b466279335e9ca9e7b7c17582b33b637c77b4b9fa8b1e9ef9152c03b44d8d", "Content-Type": "application/json"}'::jsonb,
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
