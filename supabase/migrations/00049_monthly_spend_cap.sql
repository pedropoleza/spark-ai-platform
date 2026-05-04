-- =============================================
-- 00049_monthly_spend_cap
--
-- Pedro 2026-05-04: hard cap mensal de gasto pra evitar runaway. Se algum
-- rep entrar em loop, alguém forjar webhook, ou bug fizer LLM consumir
-- demais — quem paga é Pedro (single-tenant: ele mesmo controla a agency).
--
-- Cap default: $100/mês por sub-account (cobre HEAVY user com folga, mas
-- barra runaway). Configurável por location via `monthly_spend_cap_usd`
-- em agent_configs (ou via lookup direto na location).
--
-- Comportamento: quando atinge cap, `trackAndCharge` pula o `chargeWallet`
-- e marca `usage_record.charged_to_wallet=false` + `cap_blocked=true`.
-- Bot continua RESPONDENDO (não bloqueia conversa pra rep não ter
-- experiência ruim) — mas Pedro come o custo até next mês ou liberar.
--
-- Future: pode evoluir pra "block + msg automática pro rep dizendo limite
-- atingido" — mas hoje preferimos não-degradar UX.
-- =============================================

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS monthly_spend_cap_usd numeric(10, 2) DEFAULT 100.00;

COMMENT ON COLUMN agent_configs.monthly_spend_cap_usd IS
  'Hard cap mensal de gasto (em USD) pro SparkBot. Quando atingido, charge é skipado mas bot continua respondendo. Default $100. NULL = sem cap.';

-- Adiciona campo cap_blocked em usage_records pra audit trail e tracking
ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS cap_blocked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN usage_records.cap_blocked IS
  'Quando true, usage_record foi tracked mas NÃO cobrado do wallet GHL porque a sub-account atingiu monthly_spend_cap_usd. Pedro come o custo no plataform.';

-- Index pra query rápida do total mensal por location
-- Nota: usage_records não tem coluna charged_at — usa created_at.
CREATE INDEX IF NOT EXISTS idx_usage_records_location_month
  ON usage_records(location_id, created_at DESC);
