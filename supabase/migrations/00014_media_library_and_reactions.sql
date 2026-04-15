-- Biblioteca de midia por agente. Cada entrada aponta para um arquivo
-- armazenado no Supabase Storage (bucket "agent-media").
CREATE TABLE IF NOT EXISTS media_library (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  storage_path  TEXT NOT NULL,    -- path relativo dentro do bucket
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_library_agent ON media_library(agent_id);
CREATE INDEX IF NOT EXISTS idx_media_library_location ON media_library(location_id);

-- Idempotencia das reacoes: guarda quais automation_ids ja dispararam
-- para cada conversation_state (agent+contact). Evita re-disparar a
-- mesma reacao em cada turno subsequente.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS triggered_automations JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Bucket do Storage (criado manualmente no painel do Supabase — este
-- arquivo apenas documenta). Configuracao recomendada:
--   nome: agent-media
--   publico: false (URLs assinadas por request)
--   file size limit: 25 MB
--   mime types: image/*, audio/*, video/*, application/pdf
