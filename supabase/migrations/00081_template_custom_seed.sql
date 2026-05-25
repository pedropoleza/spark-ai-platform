-- ============================================================================
-- 00081_template_custom_seed.sql — template seed 'custom' (Pedro 2026-05-25).
-- O wizard de criação oferece "Custom / Evento" (lead-facing) montado de módulos.
-- Precisa de uma linha em agent_templates pra o create resolver. Aditivo/idempotente.
-- ============================================================================
INSERT INTO agent_templates (key, name, audience, description, default_modules, is_seed) VALUES
  ('custom', 'Custom / Evento', 'lead',
   'Monte do zero — agente de evento, nicho ou temporário, com os módulos que quiser.',
   '["behavior","qualification","channel","followup"]'::jsonb, true)
ON CONFLICT (key) DO NOTHING;
