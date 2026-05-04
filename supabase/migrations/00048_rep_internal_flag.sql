-- =============================================
-- 00048_rep_internal_flag
--
-- Pedro 2026-05-04: agency owner + admins não devem ser cobrados pelo uso
-- do SparkBot (consomem recursos pra suporte/desenvolvimento, não pra
-- gerar receita). Adiciona flag `is_internal` em rep_identities.
--
-- Detecção (em ordem de prioridade):
--   1. INTERNAL_TEAM_PHONES env var (override manual; mais simples e robusto)
--   2. GHL user.type == 'agency' (se a API devolver — varia entre versões)
--   3. Phone-based heurística: rep com 5+ ghl_users distintas → provavelmente
--      agency-level (acesso a múltiplas sub-accounts). Ainda evita a coluna
--      ficar errada pra reps regulares.
--
-- Se is_internal=true, billing.charge skipa o `chargeWallet()` e marca
-- usage_record com `charged_to_wallet=false` (mas mantém audit trail).
-- =============================================

ALTER TABLE rep_identities
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN rep_identities.is_internal IS
  'Quando true, SparkBot processa requests do rep mas NÃO cobra o wallet GHL. Usado pra agency owner/admins. Detectado via INTERNAL_TEAM_PHONES env, GHL user.type=agency, ou heurística (5+ ghl_users).';

-- Index só pra queries de auditoria (raras) — não é hot path
CREATE INDEX IF NOT EXISTS idx_rep_identities_internal
  ON rep_identities(is_internal) WHERE is_internal = true;
