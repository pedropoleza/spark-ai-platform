-- ============================================================================
-- 00077_entitlement_monthly_price.sql
-- Preço padrão $50/agente (Pedro 2026-05-24). Cada entitlement (capacidade paga
-- por location) carrega seu preço mensal. Default 50; override por grant.
-- A COBRANÇA em si (self-serve/Stripe) é Fase 4 — aqui só registramos o preço.
-- Aditivo. Ver _planning/plataforma-modular/PLANO.md.
-- ============================================================================

ALTER TABLE agent_entitlements
  ADD COLUMN IF NOT EXISTS monthly_price_usd NUMERIC NOT NULL DEFAULT 50;

COMMENT ON COLUMN agent_entitlements.monthly_price_usd IS 'Preço mensal do módulo/agente pago. Default 50 (Pedro 2026-05-24). Cobrança = Fase 4.';

UPDATE agent_entitlements SET monthly_price_usd = 50 WHERE monthly_price_usd IS NULL;
