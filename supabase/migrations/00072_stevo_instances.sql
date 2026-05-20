-- =============================================================================
-- Migration 00072: stevo_instances (config da instância Stevo por Hub)
-- 2026-05-20 — Transferência COMPLETA do canal do rep pro Stevo (novo padrão;
-- GHL vira fallback). Os REPLIES já usam o serverUrl+token do próprio inbound,
-- mas os PROATIVOS (lembretes, nudges, notificações pro rep) não têm um inbound
-- de onde puxar essa config. Esta tabela guarda o serverUrl + instanceToken por
-- hub_location_id, auto-mantida a cada inbound do Stevo (upsert no stevo-handler),
-- pra que deliverProactiveMessage possa enviar via Stevo (com fallback GHL).
--
-- instance_token é credencial da instância (mesma que já vem em todo webhook e
-- já era persistida em stevo_webhook_samples). Acesso só via service-role.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stevo_instances (
  hub_location_id text        PRIMARY KEY,
  server_url      text        NOT NULL,
  instance_token  text        NOT NULL,
  instance_name   text,
  instance_id     text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stevo_instances IS
  'Config da instância Stevo por Hub (serverUrl + instanceToken). Auto-mantida a cada inbound do Stevo. Usada por deliverProactiveMessage pra enviar proativos via Stevo (GHL fallback).';
