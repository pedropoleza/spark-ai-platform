-- Campo geral de instrucoes para a base de conhecimento do agente
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS knowledge_base_instructions TEXT DEFAULT '';
