-- Sessões de teste persistentes: a aba de teste vira um clone fiel da
-- produção (WhatsApp/GHL). Elimina bugs de closure stale / serialização na UI
-- por ter a DB como source of truth do histórico.

CREATE TABLE IF NOT EXISTS agent_test_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  session_name  TEXT,
  contact_id    TEXT,               -- opcional: contato real do GHL pra testar com dados reais
  collected_data JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_test_sessions_agent
  ON agent_test_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_test_sessions_recent
  ON agent_test_sessions(agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_test_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES agent_test_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  content     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}'::jsonb,  -- tokens, duration_ms, actions, etc
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_test_messages_session
  ON agent_test_messages(session_id, created_at);

-- Trigger para manter updated_at da sessão em sync com a última mensagem
CREATE OR REPLACE FUNCTION touch_test_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE agent_test_sessions
  SET updated_at = NEW.created_at
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_test_session ON agent_test_messages;
CREATE TRIGGER trg_touch_test_session
  AFTER INSERT ON agent_test_messages
  FOR EACH ROW
  EXECUTE FUNCTION touch_test_session_updated_at();
