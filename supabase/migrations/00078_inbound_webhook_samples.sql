-- ============================================================================
-- 00078_inbound_webhook_samples.sql — captura raw do webhook inbound (diagnóstico).
--
-- Pedro 2026-05-24: pra confirmar se o GHL encaminha DMs (IG etc) pro nosso
-- /api/webhooks/inbound-message e com qual payload. Capped (prune p/ últimos 100
-- no helper). Aditivo, debug-only — pode dropar depois. RLS deny-anon (00040).
-- Gate: env INBOUND_WEBHOOK_CAPTURE (default ON; "off" desliga).
-- ============================================================================

CREATE TABLE IF NOT EXISTS inbound_webhook_samples (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  location_id       TEXT,
  contact_id        TEXT,
  message_type      TEXT,
  detected_channel  TEXT,
  message_direction TEXT,
  is_real_message   BOOLEAN,
  raw               JSONB
);
CREATE INDEX IF NOT EXISTS idx_inbound_webhook_samples_received ON inbound_webhook_samples(received_at DESC);

ALTER TABLE inbound_webhook_samples ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_anon_all ON inbound_webhook_samples AS RESTRICTIVE FOR ALL TO anon USING (false);
