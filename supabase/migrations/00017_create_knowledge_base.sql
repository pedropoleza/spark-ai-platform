-- Tabela de base de conhecimento por agente.
-- Conteudo eh extraido (PDF, texto, URL) e injetado no prompt da IA.
CREATE TABLE IF NOT EXISTS knowledge_base (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  location_id         TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('text', 'file', 'url')),
  title               TEXT NOT NULL,
  content             TEXT NOT NULL DEFAULT '',
  file_name           TEXT,
  file_url            TEXT,
  token_count         INTEGER DEFAULT 0,
  description         TEXT,
  usage_instructions  TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_agent ON knowledge_base(agent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_location ON knowledge_base(location_id);
