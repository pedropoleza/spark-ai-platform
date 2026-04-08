-- Tabela de locations (tenants)
CREATE TABLE locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   TEXT NOT NULL UNIQUE,
  company_id    TEXT NOT NULL,
  location_name TEXT,
  timezone      TEXT DEFAULT 'America/New_York',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_locations_location_id ON locations(location_id);
CREATE INDEX idx_locations_company_id ON locations(company_id);
