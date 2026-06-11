-- =============================================
-- 00102_bulk_recipients_claim_columns
--
-- H37 (Pedro 2026-06-10): reclaim de recipients órfãos presos em 'sending'.
--
-- PROBLEMA: bulk_message_recipients (00050) não tinha claim_token/claimed_at.
-- Quando o lambda do Vercel morre (timeout maxDuration=60s, OOM, ou deploy no
-- meio) ENTRE o claim atômico (status pending→sending no bulk-message-runner)
-- e o UPDATE final (→sent/failed), a row fica presa em 'sending' PRA SEMPRE:
--   1. refreshJobCounters() exige `sending===0` pra marcar o job 'completed' →
--      o job fica 'running' eternamente e o rep NUNCA recebe a notificação de
--      conclusão (notifyRepJobCompleted nunca dispara).
--   2. bulk-runner-health-check Check 2 só olha recipients 'pending' overdue →
--      um job cujo único straggler é 'sending' fica invisível pro alerta também.
-- Nada no repo revertia 'sending'→'pending' (diferente do reaper H12 do
-- message_queue, que reseta 'processing' órfão — mas aquela tabela tem
-- updated_at pra medir idade; aqui faltava um timestamp de claim).
--
-- FIX: espelha o schema do followup_messages (00067) — claim_token + claimed_at.
-- O runner passa a (a) carimbar claimed_at no claim atômico e (b) reverter pra
-- 'pending' recipients presos em 'sending' há mais que ~3min
-- (reclaimOrphanedSending em bulk-message-runner.ts). 3min é folga grande sobre
-- o maxDuration de 60s do lambda — nenhum tick vivo ainda segura a row, então o
-- revert é seguro.
--
-- TRADEOFF de idempotência: reverter uma row cujo GHL send REALMENTE completou
-- (mas o lambda morreu antes do UPDATE) causa 1 reenvio. Aceito: a janela de
-- 3min torna isso raríssimo, e 1 msg duplicada << job preso pra sempre. Mesma
-- decisão do reaper H12 — só que lá a idempotência final é o UNIQUE de
-- ghl_message_id; aqui NÃO temos esse seguro, então a janela de idade é a
-- única proteção (por isso só revertemos rows velhas o suficiente).
--
-- Aditivo e backward-compatible: colunas nullable, sem default destrutivo.
-- =============================================

ALTER TABLE bulk_message_recipients
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN bulk_message_recipients.claim_token IS
  'Token do claim atômico do runner (1 uuid por tick). Espelha followup_messages. Limpo (NULL) quando a row é revertida por ser órfã.';
COMMENT ON COLUMN bulk_message_recipients.claimed_at IS
  'Quando a row foi reivindicada (pending→sending). reclaimOrphanedSending usa pra detectar órfãos (>3min em sending = lambda morreu). NULL = nunca reivindicada ou claim de código pré-00102.';

-- Backfill defensivo: carimba claimed_at=now() em qualquer row JÁ presa em
-- 'sending' no momento do deploy (claim por código pré-00102, portanto sem
-- timestamp). O runtime também cobre claimed_at NULL via scheduled_at, mas esse
-- carimbo dá idade explícita às órfãs históricas e some com o backlog no 1º
-- tick após a janela de 3min. Rows reivindicadas pelo código novo já têm
-- claimed_at e não são tocadas (WHERE claimed_at IS NULL).
UPDATE bulk_message_recipients
  SET claimed_at = now()
  WHERE status = 'sending' AND claimed_at IS NULL;

-- Index parcial: o reclaim varre só o conjunto pequeno de 'sending' (normal
-- 0-5 rows; órfãs só acumulam em morte de lambda).
CREATE INDEX IF NOT EXISTS idx_bulk_recipients_sending_claimed
  ON bulk_message_recipients (claimed_at)
  WHERE status = 'sending';
