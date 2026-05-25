-- ============================================================================
-- 00080_agent_type_custom.sql — adiciona 'custom_agent' ao enum agent_type.
--
-- Plataforma Modular (Pedro 2026-05-25): o wizard cria agentes CUSTOM (evento,
-- nicho, etc.) lead-facing, montados de módulos. Aditivo.
-- Obs: o runtime do custom_agent no pipeline lead (selecioná-lo junto de
-- sales/recruitment no webhook + queue) é follow-up — esta migração só habilita
-- o tipo no enum pra o registro do agente ser válido.
-- ============================================================================
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'custom_agent';
