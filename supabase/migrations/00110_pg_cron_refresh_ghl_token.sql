-- =============================================
-- 00110_pg_cron_refresh_ghl_token (Pedro 2026-06-16)
--
-- Gatilho CONFIÁVEL pro refresh do GHL company token, a cada 6h.
--
-- PROBLEMA (apagões recorrentes de token): o refresh era 1 cron da Vercel
-- (`0 6 * * *`, em vercel.json) que (a) é frágil — Vercel Hobby não dispara
-- cron de forma confiável (mesmo motivo do task #15 que moveu os outros pro
-- pg_cron) — e (b) rodava com `GHL_CLIENT_ID` ERRADO no env de produção, então
-- o GHL rejeitava o refresh com `400 invalid_request: Invalid parameter
-- client_id`. Resultado: o token de 24h não era renovado e expirava → toda a
-- integração GHL caía (SparkBot "não puxa", agentes mudos). Só não morria de
-- vez porque era refreshado MANUALMENTE (script reauth, com o client_id certo
-- do .env.local). Diagnóstico em [memória sparkbot/token].
--
-- FIX (2 partes):
--   1. 👤 env da Vercel: GHL_CLIENT_ID/SECRET corrigidos pro app 67cf4ed4… +
--      redeploy. O endpoint /api/cron/refresh-ghl-token passou a dar 200
--      `refreshed:1` (verificado via net.http_get).
--   2. (esta migration) pg_cron a cada 6h batendo o endpoint — mesma infra
--      confiável do sparkbot-proactive. Token vive 24h; refresh a cada 6h dá
--      margem pra perder 3 ciclos sem expirar.
--
-- Horas 02/08/14/20 UTC de propósito: NÃO colidem com o cron 06:00 da Vercel
-- (que pode ficar por ora) — evita 2 refreshes simultâneos disputando o
-- refresh_token single-use (o perdedor falharia e geraria signal falso).
--
-- Auth: header `x-vercel-cron: 1` (a rota aceita; a Vercel não corta o header
-- em request externo — testado, retornou 200). `cron_config.base_url` (id=1) já
-- existe e aponta pro domínio de produção.
--
-- FOLLOW-UP opcional: remover o cron `0 6 * * *` do vercel.json (redundante +
-- frágil) — não-urgente, refreshes extras são idempotentes.
-- =============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-ghl-token-6h') THEN
    PERFORM cron.unschedule('refresh-ghl-token-6h');
  END IF;
END $$;

SELECT cron.schedule(
  'refresh-ghl-token-6h',
  '0 2,8,14,20 * * *',
  $cron$
  SELECT net.http_get(
    url := (SELECT base_url || '/api/cron/refresh-ghl-token' FROM public.cron_config WHERE id = 1),
    headers := jsonb_build_object('x-vercel-cron', '1'),
    timeout_milliseconds := 25000
  );
  $cron$
);
