-- ============================================================================
-- sparkbot_turn_locks — um turno por rep de cada vez.
--
-- MOTIVAÇÃO (review de uso 2026-08-25, caso Daniely Jones 24/08 23:51)
-- A rep mandou 4 mensagens em 27 segundos. Cada uma virou um webhook, cada
-- webhook virou uma lambda, e as lambdas rodaram em PARALELO lendo históricos
-- diferentes. O que saiu:
--
--   23:51:33  BOT   "Marcar qual Thaty? 1. Thaty Gomes  2. ...  3. Outro número"
--   23:51:51  BOT   "Marcado! ✅ Thaty Gomes - terça 25/08 às 17:00"   ← agendou
--   23:51:55  REP   "Outro número (+1 407 760-1354)"                   ← a resposta
--   23:53:29  BOT   "Marcado! ✅ Tatiane Ribeiro - terça 25/08 às 17:00"
--
-- O turno que agendou "Thaty Gomes" leu um histórico onde a pergunta "qual
-- Thaty?" estava sem resposta, e escolheu sozinho — 4 segundos ANTES da rep
-- responder. No briefing do dia seguinte apareceram TRÊS reuniões às 18h.
--
-- POR QUE AS DEFESAS EXISTENTES NÃO PEGAM
--  • STEVO_DEBOUNCE_MS está 0 (desligado) em produção.
--  • `shouldStillRespond` roda PRÉ-ENVIO — quando ele detecta que outro turno
--    respondeu, o create_appointment já rodou. E o código, corretamente, se
--    recusa a descartar turno COM efeito colateral (descartar o texto não
--    desfaz a reunião). A trava tem que vir ANTES da tool, não depois.
--
-- COMO FUNCIONA
-- Uma linha por rep. Quem chega primeiro insere e roda; quem chega depois
-- espera (poll curto) e só então lê o histórico — que a essa altura já contém
-- a resposta do turno anterior. Não descarta mensagem: o que espera SEMPRE
-- roda, com contexto completo em vez de contexto pela metade.
--
-- expires_at cobre lambda morta (maxDuration=60 → TTL 75s). O claim rouba lock
-- vencido de forma atômica (UPDATE ... WHERE expires_at < now()).
-- ============================================================================

CREATE TABLE IF NOT EXISTS sparkbot_turn_locks (
  rep_id      uuid PRIMARY KEY,
  message_id  text,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '75 seconds')
);

CREATE INDEX IF NOT EXISTS idx_sparkbot_turn_locks_expires
  ON sparkbot_turn_locks(expires_at);

COMMENT ON TABLE sparkbot_turn_locks IS
  'Serializa os turnos do SparkBot por rep. Sem isso, rajada de mensagens vira lambdas concorrentes que leem históricos parciais e agem sem a resposta do rep (caso Daniely 24/08: agendou 4s antes de ela responder qual contato era). Uma linha por rep, TTL 75s > maxDuration 60s. Quem não pega o lock ESPERA — nunca descarta a mensagem.';

-- Faxina de segurança: se o release falhar (lambda morta no meio), a linha
-- vencida some sozinha. O claim já rouba lock vencido, então isso é só higiene.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sparkbot-turn-locks-cleanup') THEN
      PERFORM cron.unschedule('sparkbot-turn-locks-cleanup');
    END IF;
    PERFORM cron.schedule(
      'sparkbot-turn-locks-cleanup',
      '*/5 * * * *',
      $cleanup$DELETE FROM sparkbot_turn_locks WHERE expires_at < now() - interval '5 minutes'$cleanup$
    );
  END IF;
END $$;
