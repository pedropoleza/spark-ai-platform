-- 20260806041954_sparkbot_webhook_commands.sql
--
-- H71 (Pedro 2026-08-05) — Comandos via webhook do Spark Leads → SparkBot.
-- Automação de dentro de uma sub-conta manda ordem pro bot: `notification`
-- (o texto vai cru pro WhatsApp do corretor) ou `prompt` (o bot responde e a
-- resposta DELE vai). Endpoint: POST /api/webhooks/sparkbot-command.
--
-- NOME EM TIMESTAMP de propósito: o número curto já foi disputado por
-- conteúdos diferentes em branches paralelas (ver
-- _planning/auditoria-trabalho-perdido-2026-08-05.md). Timestamp não colide.
--
-- Pra que esta tabela existe: sem ela, "meu webhook não chegou" vira
-- investigação em log de lambda. TODA tentativa que passa do rate limit grava
-- uma linha — inclusive as REJEITADAS, com o motivo legível. A auditoria é a
-- resposta, não a pista.
--
-- Ela também é o mecanismo de idempotência. O webhook do Spark Leads reentrega
-- em cima de timeout, e automação com dois caminhos dispara duas vezes. A linha
-- nasce com status 'running' ANTES de o comando executar (claim): sem isso, o
-- modo prompt — que leva ~20s de LLM — não enxergaria a execução gêmea que
-- começou 2s depois, e o corretor receberia duas mensagens.

CREATE TABLE IF NOT EXISTS sparkbot_webhook_commands (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- De onde veio e pra quem foi.
  location_id    TEXT,
  rep_id         UUID REFERENCES rep_identities(id) ON DELETE SET NULL,
  send_to        TEXT,

  -- O que foi pedido.
  kind           TEXT,
  message        TEXT,
  contact_id     TEXT,

  -- Idempotência: request_id quando a automação manda um (janela de 24h),
  -- fingerprint do conteúdo quando não manda (janela curta, 60s default).
  request_id     TEXT,
  fingerprint    TEXT,

  -- Resultado.
  status         TEXT NOT NULL,
  reason         TEXT,
  detail         TEXT,
  delivered_via  TEXT,
  response_text  TEXT,
  duration_ms    INTEGER,

  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 'running' é estado normal, não erro: a linha é criada antes de executar.
-- Linha que FICA em running (lambda morreu no meio) é sinal visível na
-- auditoria — de propósito, não é bug.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sparkbot_webhook_commands_status_chk'
  ) THEN
    ALTER TABLE sparkbot_webhook_commands
      ADD CONSTRAINT sparkbot_webhook_commands_status_chk
      CHECK (status IN ('running', 'sent', 'rejected', 'failed', 'duplicate'));
  END IF;
END $$;

-- "o que essa conta mandou hoje" — a consulta do suporte.
CREATE INDEX IF NOT EXISTS idx_sparkbot_webhook_commands_location
  ON sparkbot_webhook_commands (location_id, received_at DESC);

-- Cap diário por corretor (contarEnviosRecentes) + "o que esse corretor recebeu".
CREATE INDEX IF NOT EXISTS idx_sparkbot_webhook_commands_rep
  ON sparkbot_webhook_commands (rep_id, received_at DESC);

-- Dedup por conteúdo quando não veio request_id.
CREATE INDEX IF NOT EXISTS idx_sparkbot_webhook_commands_fingerprint
  ON sparkbot_webhook_commands (fingerprint, received_at DESC);

-- Idempotência DURA quando a automação manda request_id. O SELECT de duplicata
-- resolve o caso comum; este índice fecha a corrida em que os dois webhooks
-- fazem o claim no mesmo instante e nenhum enxerga o outro. O segundo INSERT
-- estoura violação de unicidade, a rota lê isso como "duplicata" e não envia.
--
-- O predicado inclui o STATUS de propósito: só 'running' e 'sent' seguram a
-- vaga. Sem isso, uma tentativa REJEITADA (destino errado, corretor de outra
-- conta) gravaria a linha com o mesmo request_id e o Pedro nunca mais
-- conseguiria reenviar aquele evento depois de arrumar a automação — o retry
-- bateria no índice e voltaria "duplicata" pra um comando que nunca rodou.
-- 'failed' também libera: comando que não entregou pode ser repetido.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sparkbot_webhook_commands_request
  ON sparkbot_webhook_commands (location_id, request_id)
  WHERE request_id IS NOT NULL AND status IN ('running', 'sent');

-- RLS — mesmo padrão das outras tabelas do SparkBot: nega anon, consumo só
-- server-side pelo service_role. A tabela guarda texto de mensagem e telefone
-- de corretor; não pode vazar pela anon key do browser.
ALTER TABLE sparkbot_webhook_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON sparkbot_webhook_commands;
CREATE POLICY deny_anon_all ON sparkbot_webhook_commands AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

COMMENT ON TABLE sparkbot_webhook_commands IS
  'H71: trilha de auditoria + idempotência dos comandos que as automações do Spark Leads mandam pro SparkBot (POST /api/webhooks/sparkbot-command). Grava também as tentativas REJEITADAS, com o motivo.';
COMMENT ON COLUMN sparkbot_webhook_commands.status IS
  'running (claim, antes de executar) | sent | rejected (barrado numa das travas) | failed (executou e não entregou) | duplicate';
COMMENT ON COLUMN sparkbot_webhook_commands.send_to IS
  'Telefone do CORRETOR que recebeu. Nunca o do lead: o campo `phone` do payload de automação é ignorado de propósito na resolução do destino.';
