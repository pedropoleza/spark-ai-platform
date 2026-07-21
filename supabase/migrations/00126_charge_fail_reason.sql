-- A7 (estudo de custo 2026-07-20 / Onda A): causa da falha de cobrança persistida
-- no próprio usage_record.
--
-- Motivação: $85 de charges pendentes nos 30d onde "não cobrado" não distinguia
-- wallet sem saldo (esperado — auto-cura na recarga, H52) de bug de token/config
-- (perda silenciosa de receita). O achado do ultra-review "location 7pXJ presa sem
-- estar wallet-blocked" só foi diagnosticável com SQL manual — esta coluna torna a
-- causa consultável direto.
--
-- Preenchida no catch do chargeUnbilledRecords e do trackAndCharge
-- (markChargeFailReason, best-effort); limpa quando a cobrança finalmente passa
-- (markWalletCharged seta NULL). Aditiva e retrocompatível.

ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS charge_fail_reason text;

COMMENT ON COLUMN usage_records.charge_fail_reason IS
  'A7 2026-07-20: última causa de falha de cobrança no wallet GHL (ex: insufficient funds, sem company_id). NULL = nunca falhou ou cobrança concluída.';
