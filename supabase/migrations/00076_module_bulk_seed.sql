-- ============================================================================
-- 00076_module_bulk_seed.sql
-- Plataforma Modular — adiciona o módulo de catálogo `bulk` (disparo em massa).
--
-- Pedro 2026-05-24: ao mapear as ~12 tools de bulk (bulk_dashboard, bulk_pause_all,
-- schedule_bulk_message_v2, etc.) vimos que não encaixam nos 9 módulos seed —
-- viram um módulo próprio `bulk` (lead-facing). Aditivo, idempotente.
-- Ver _planning/plataforma-modular/PLANO.md.
-- ============================================================================

INSERT INTO agent_modules (key, name, category, audience_scope, is_seed) VALUES
  ('bulk', 'Disparo em Massa', 'bulk', 'lead', true)
ON CONFLICT (key, version) DO NOTHING;
