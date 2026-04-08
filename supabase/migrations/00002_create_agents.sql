-- Tipos de agente e status
CREATE TYPE agent_type AS ENUM ('sales_agent', 'account_assistant');
CREATE TYPE agent_status AS ENUM ('active', 'inactive');

-- Tabela de agentes (instancias por location)
CREATE TABLE agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   TEXT NOT NULL REFERENCES locations(location_id) ON DELETE CASCADE,
  type          agent_type NOT NULL,
  status        agent_status NOT NULL DEFAULT 'inactive',
  name          TEXT NOT NULL DEFAULT 'Agente de Vendas',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(location_id, type)
);

CREATE INDEX idx_agents_location_id ON agents(location_id);
CREATE INDEX idx_agents_status ON agents(status) WHERE status = 'active';
