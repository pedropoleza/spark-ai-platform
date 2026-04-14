-- Toggle: pausar a IA automaticamente quando qualquer mensagem manual for enviada
-- (substitui a necessidade de cadastrar mensagens fixas de encerramento).
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS auto_pause_on_human_message BOOLEAN NOT NULL DEFAULT false;
