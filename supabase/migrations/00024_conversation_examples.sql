ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS conversation_examples TEXT;
