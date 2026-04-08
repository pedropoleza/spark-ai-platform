-- Status de conversacao
CREATE TYPE conversation_status AS ENUM (
  'active',
  'qualified',
  'booked',
  'disqualified',
  'handed_off',
  'stale'
);

-- Estado de cada conversa ativa
CREATE TABLE conversation_state (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id       TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  status            conversation_status DEFAULT 'active',
  collected_data    JSONB DEFAULT '{}'::jsonb,
  message_count     INTEGER DEFAULT 0,
  last_message_at   TIMESTAMPTZ,
  last_ai_response_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, contact_id)
);

CREATE INDEX idx_conversation_state_location ON conversation_state(location_id);
CREATE INDEX idx_conversation_state_contact ON conversation_state(contact_id);
CREATE INDEX idx_conversation_state_status ON conversation_state(status) WHERE status = 'active';
