-- =============================================
-- 00111_signals_alert_push (Pedro 2026-06-17)
--
-- O DESTRAVADOR da observabilidade. Até aqui, TODO problema de produção
-- (token caído, onboarding de rep mudo, disparo travado, agente em loop)
-- só era descoberto quando o Pedro reclamava — os admin_signals existiam
-- mas ninguém os via em tempo real. Esta migration habilita o PUSH:
--
--   1. Coluna `admin_signals.last_alerted_at` — guarda quando o sinal foi
--      empurrado pro canal pela última vez (anti-spam do cron de alerta).
--
--   2. pg_cron `signals-alert-5min` — a cada 5min bate /api/cron/signals-alert,
--      que empurra os sinais críticos (Telegram/Slack) e roda um dead-man
--      dos runners proativos. Mesma infra confiável do sparkbot-proactive e
--      do refresh-ghl-token-6h (pg_net + cron_config.base_url + x-vercel-cron).
--
-- O endpoint é NO-OP no push enquanto não houver canal configurado
-- (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID, ou ALERT_SLACK_WEBHOOK
-- no env da Vercel) — então é seguro agendar já; o Pedro liga o push depois
-- só setando o secret. O dead-man dos runners já grava signal no painel
-- mesmo sem canal.
--
-- Auth: header `x-vercel-cron: 1` (a rota aceita via isAuthorizedCron).
-- =============================================

ALTER TABLE public.admin_signals ADD COLUMN IF NOT EXISTS last_alerted_at timestamptz;

-- Índice parcial pros sinais abertos (o cron filtra status='open' a cada 5min).
CREATE INDEX IF NOT EXISTS idx_admin_signals_open_alerting
  ON public.admin_signals (last_seen_at DESC)
  WHERE status = 'open';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'signals-alert-5min') THEN
    PERFORM cron.unschedule('signals-alert-5min');
  END IF;
END $$;

SELECT cron.schedule(
  'signals-alert-5min',
  '*/5 * * * *',
  $cron$
  SELECT net.http_get(
    url := (SELECT base_url || '/api/cron/signals-alert' FROM public.cron_config WHERE id = 1),
    headers := jsonb_build_object('x-vercel-cron', '1'),
    timeout_milliseconds := 25000
  );
  $cron$
);
