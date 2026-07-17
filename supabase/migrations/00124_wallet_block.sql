-- 00124_wallet_block.sql
--
-- Bloqueio por wallet sem saldo (Pedro 2026-07-17, ultra-review P0-2).
-- Motivação: 2 locations ficaram sem crédito no wallet e a IA seguiu rodando
-- DE GRAÇA em silêncio (~$72 acumulados, cobrança falhando a cada hora com
-- "insufficient funds"). Decisão do Pedro: bloquear a IA e avisar que o saldo
-- acabou (recarga na wallet do Spark Leads; suporte +1 786 771-7077).
--
-- wallet_blocked_at        — setado pelo charge.ts na 1ª falha por saldo;
--                            limpo automaticamente quando uma cobrança passa.
-- wallet_block_notified_at — última vez que a dona da conta foi avisada via
--                            SparkBot (aviso 1x/24h enquanto bloqueada).

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS wallet_blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS wallet_block_notified_at timestamptz;

COMMENT ON COLUMN locations.wallet_blocked_at IS
  'IA bloqueada por wallet sem saldo (GHL insufficient funds). NULL = liberada. Ver src/lib/billing/wallet-block.ts';
COMMENT ON COLUMN locations.wallet_block_notified_at IS
  'Último aviso de saldo esgotado entregue à dona da conta via SparkBot (cooldown 24h).';
