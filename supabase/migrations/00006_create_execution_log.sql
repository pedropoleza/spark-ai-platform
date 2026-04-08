-- Log de execucao (audit trail)
CREATE TABLE execution_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id   TEXT,
  contact_id        TEXT,
  location_id       TEXT NOT NULL,
  action_type       TEXT NOT NULL,
  action_payload    JSONB DEFAULT '{}'::jsonb,
  ai_model_used     TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  success           BOOLEAN DEFAULT true,
  error_message     TEXT,
  duration_ms       INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_execution_log_location ON execution_log(location_id);
CREATE INDEX idx_execution_log_created ON execution_log(created_at DESC);
CREATE INDEX idx_execution_log_agent ON execution_log(agent_id) WHERE agent_id IS NOT NULL;
