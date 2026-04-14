-- Vincula cada mensagem enfileirada explicitamente ao agente que vai processar.
-- Sem isso, o processor tinha que readivinhar o agente pela location, o que
-- quebra quando ha sales_agent e recruitment_agent ativos na mesma location.
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_message_queue_agent
  ON message_queue(agent_id) WHERE agent_id IS NOT NULL;
