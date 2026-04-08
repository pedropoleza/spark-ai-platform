-- Status da fila
CREATE TYPE queue_status AS ENUM ('pending', 'processing', 'completed', 'failed');

-- Fila de mensagens (buffer de debounce)
CREATE TABLE message_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  message_body      TEXT NOT NULL,
  message_type      TEXT DEFAULT 'SMS',
  message_direction TEXT DEFAULT 'inbound',
  ghl_message_id    TEXT,
  received_at       TIMESTAMPTZ DEFAULT now(),
  process_after     TIMESTAMPTZ NOT NULL,
  status            queue_status DEFAULT 'pending',
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Index para buscar mensagens prontas para processar
CREATE INDEX idx_message_queue_ready
  ON message_queue(process_after)
  WHERE status = 'pending';

CREATE INDEX idx_message_queue_contact
  ON message_queue(location_id, contact_id, status);
