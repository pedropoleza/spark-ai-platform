-- =============================================================================
-- Migration 00069: confirmation_mode default -> 'high_only'
-- V2.1 da refatoração (2026-05-20) — decisão D3 aprovada pelo Pedro.
--
-- Motivação:
--   Havia drift entre o DEFAULT do DB (migration 00029 criou agent_configs com
--   confirmation_mode default 'medium_and_high') e o fallback do código
--   (processor/webhook-handler usam `|| 'high_only'`). O agente de prod tem
--   'high_only' explícito, mas um agent_config NOVO nascia 'medium_and_high' e
--   passava a confirmar todo write 'medium' — inconsistência entre ambientes.
--
--   D3: 'high_only' é o padrão oficial (menos over-confirmação; ações medium
--   como nota/task/tag/opportunity executam direto). Alinha o DB default ao
--   comportamento de prod.
--
-- Seguro: NÃO altera rows existentes (só o default pra inserts futuros).
-- =============================================================================

ALTER TABLE public.agent_configs
  ALTER COLUMN confirmation_mode SET DEFAULT 'high_only';
