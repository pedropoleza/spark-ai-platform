-- =============================================
-- 00052_terms_rejected_at
--
-- Pedro 2026-05-05 (ULTRA-REVIEW Track 1 C1): rep que recusa termos
-- não tinha persistência → bot entrava em loop reenviando termos toda
-- mensagem posterior. Persist `terms_rejected_at` permite gate de
-- silêncio em processor.ts. Pra desbloquear: admin limpa via
-- `UPDATE rep_identities SET terms_rejected_at = NULL WHERE id = X`.
--
-- Aplicada em prod via MCP pré-criação deste arquivo. Idempotente.
-- =============================================

ALTER TABLE rep_identities
  ADD COLUMN IF NOT EXISTS terms_rejected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rep_identities_terms_rejected
  ON rep_identities(terms_rejected_at)
  WHERE terms_rejected_at IS NOT NULL;

COMMENT ON COLUMN rep_identities.terms_rejected_at IS
  'Timestamp em que rep rejeitou termos. Bot silencia até admin limpar manual.';
