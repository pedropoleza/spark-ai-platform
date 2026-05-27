-- =============================================================================
-- Migration 00087: cria SÓ a tabela public.cron_config (sem recriar jobs).
-- Follow-up da 00086 (ultra-review 2026-05-26).
--
-- Motivação:
--   A 00086 (cron 'billing-retry') lê url+secret de public.cron_config em
--   runtime — mesmo padrão da 00070. Mas a 00070 tem no header "⚠️ NÃO foi
--   aplicada via MCP" e de fato NUNCA foi aplicada à PROD: os jobs em prod
--   (sparkbot-proactive/followup-runner/process-message-queue) ainda usam a
--   versão antiga com url+secret HARDCODED (00053 etc.). Logo cron_config não
--   existe em prod e o 'billing-retry' falhava todo tick com
--   `relation "public.cron_config" does not exist`.
--
--   Esta migration landa APENAS a tabela + a row singleton (idempotente),
--   extraída da 00070 — SEM recriar o job sparkbot-proactive (que está
--   funcionando; recriá-lo exigiria smoke supervisionado, ver header da 00070).
--   Com a tabela no ar, o job 'billing-retry' (já agendado pela 00086) passa a
--   resolver url+secret e funciona no próximo tick.
--
--   Em fresh branch/staging: a 00070 roda ANTES desta e já cria cron_config →
--   aqui o INSERT é no-op (ON CONFLICT DO NOTHING). Convergente.
--
-- Nota de segurança: o proactive_secret abaixo é o MESMO valor já presente na
--   00070 no repo (rotacionado na 00041) e idêntico ao Bearer dos jobs de prod
--   que funcionam — então não há exposição nova aqui. TODO(futuro, herdado da
--   00070): mover o secret pra Vault/env em vez de tabela.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cron_config (
  id                int         PRIMARY KEY DEFAULT 1,
  base_url          text        NOT NULL,
  proactive_secret  text        NOT NULL,
  updated_at        timestamptz DEFAULT now(),
  CONSTRAINT cron_config_singleton CHECK (id = 1)
);

INSERT INTO public.cron_config (id, base_url, proactive_secret)
VALUES (
  1,
  'https://spark-ai-platform.vercel.app',
  'ea1b466279335e9ca9e7b7c17582b33b637c77b4b9fa8b1e9ef9152c03b44d8d'
)
ON CONFLICT (id) DO NOTHING;
