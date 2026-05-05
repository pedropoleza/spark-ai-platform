-- =============================================
-- 00056_usage_records_schema_drift_recovery
--
-- Pedro 2026-05-05 (ULTRA-REVIEW re-validation): schema drift descoberto.
-- charge.ts inseria/usava colunas que NÃO existiam na tabela real:
--   cached_tokens, cache_creation_tokens, audio_seconds, audio_model,
--   image_count, charged_at, claim_token, claimed_at.
-- Migration 00040 declarou várias delas mas DB original (criado via
-- SETUP.sql pré-00040) só tinha o subset básico. Supabase silently drop
-- colunas desconhecidas em INSERTs, mascarando o problema.
--
-- Resultado pré-fix: Whisper billing, Vision billing, prompt cache,
-- claim atomic — TODOS quebrados silenciosamente em prod. Aplicada via MCP.
-- =============================================

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS cached_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS audio_seconds NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS audio_model TEXT,
  ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN usage_records.cached_tokens IS 'Anthropic prompt cache hit tokens. Não cobrados full price.';
COMMENT ON COLUMN usage_records.cache_creation_tokens IS 'Anthropic cache creation tokens. 25% mais caro que input regular.';
COMMENT ON COLUMN usage_records.audio_seconds IS 'Segundos de audio Whisper ($0.006/min).';
COMMENT ON COLUMN usage_records.image_count IS 'Imagens Vision (~$0.001-0.003/img).';
COMMENT ON COLUMN usage_records.claim_token IS 'Atomic claim pra cron retry — anti double-charge.';
COMMENT ON COLUMN usage_records.claimed_at IS 'Timestamp do claim atômico.';

DROP INDEX IF EXISTS idx_usage_records_unbilled_capready;
CREATE INDEX IF NOT EXISTS idx_usage_records_unbilled_capready
  ON usage_records(created_at)
  WHERE charged_to_wallet = false
    AND uses_custom_key = false
    AND cap_blocked = false
    AND total_charge_usd > 0;

CREATE INDEX IF NOT EXISTS idx_usage_records_claim_token
  ON usage_records(claim_token)
  WHERE claim_token IS NOT NULL;
