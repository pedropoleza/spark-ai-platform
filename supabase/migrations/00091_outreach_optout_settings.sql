-- Outreach opt-out settings por location (Etapa 4.8 — Pedro 2026-05-28).
-- _planning/_gaps-prospeccao-2026-05-28/PLANO.md §6.8 + D3.
--
-- Default global PT+EN: STOP, PARAR, CANCELAR, SAIR, UNSUBSCRIBE, DESCADASTRAR
-- (hardcoded em lib/account-assistant/proactive/optout-detector.ts).
-- Esta tabela guarda keywords ADICIONAIS por location (admin pode adicionar
-- "OFF", "REMOVA", etc). NULL = só usa defaults.
--
-- Idempotente. RLS deny-anon.

CREATE TABLE IF NOT EXISTS location_outreach_settings (
  location_id              TEXT PRIMARY KEY,
  -- Keywords adicionais à lista global (case-insensitive, comparado por trim).
  custom_optout_keywords   TEXT[] NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE location_outreach_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON location_outreach_settings;
CREATE POLICY deny_anon_all ON location_outreach_settings AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

COMMENT ON TABLE location_outreach_settings IS
  'Pedro 2026-05-28: settings per-location pra opt-out. Keywords customizadas adicionam à lista global PT+EN.';
COMMENT ON COLUMN location_outreach_settings.custom_optout_keywords IS
  'Lista de strings (case-insensitive) que viram opt-out quando contato responde com essa palavra exata. Aditivo aos defaults.';
