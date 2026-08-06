-- 20260622015037_onboarding_signals_rpc.sql
--
-- RECUPERADA DO LEDGER em 2026-08-06, não reescrita à mão. Esta migration foi
-- aplicada em produção em 2026-06-22 e o arquivo nunca chegou ao repo — o mesmo
-- vazamento que a auditoria do H70 mapeou (`_planning/auditoria-trabalho-perdido-2026-08-05.md`).
--
-- O SQL abaixo é VERBATIM o que rodou: veio de
-- `supabase_migrations.schema_migrations.statements` do projeto de produção, a
-- coluna onde o Supabase guarda o texto executado. Nada foi inferido a partir do
-- schema atual, então um staging novo reproduz prod na ordem certa.
--
-- Nome em TIMESTAMP porque é a `version` que já está no ledger de produção:
-- mudar o nome faria o `db push` tentar reaplicar. Não editar este arquivo —
-- correção vira migration NOVA.
--
-- RPC `get_onboarding_signals(text)` — booleans de ativação do SparkBot por
-- location, consumida pelo widget de onboarding no browser (anon). Devolve só
-- true/false, nunca conteúdo de mensagem.

-- RPC pro widget de onboarding (browser-side, anon) detectar ativação REAL do SparkBot.
-- Retorna SÓ booleans (zero conteúdo de mensagem), por active_location_id. Seguro p/ anon.
-- Sinais: rep mandou 1ª msg (role=user), SparkBot respondeu (role=assistant),
-- WhatsApp conectado (existe qualquer msg channel=whatsapp na location).
CREATE OR REPLACE FUNCTION public.get_onboarding_signals(p_location_id text)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'sparkbot_user_msg', EXISTS (SELECT 1 FROM sparkbot_messages WHERE active_location_id = p_location_id AND role = 'user'),
    'sparkbot_reply',    EXISTS (SELECT 1 FROM sparkbot_messages WHERE active_location_id = p_location_id AND role = 'assistant'),
    'whatsapp_connected',EXISTS (SELECT 1 FROM sparkbot_messages WHERE active_location_id = p_location_id AND channel = 'whatsapp')
  );
$$;
REVOKE ALL ON FUNCTION public.get_onboarding_signals(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_onboarding_signals(text) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.get_onboarding_signals(text) IS
  'Onboarding widget helper — booleans de ativação do SparkBot por active_location_id. Sem conteúdo. Usado pelo spark-onboarding.js (anon).';
