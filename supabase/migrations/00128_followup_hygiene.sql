-- 00128_followup_hygiene.sql
--
-- Higiene do follow-up (MC-1/MC-2, review profundo conta Marcia 2026-07-28).
--
-- Contexto: coortes de follow-up criadas em lote vencem no mesmo segundo; um
-- tick claimava 20 rows e a lambda morria por timeout no meio do loop → rows
-- presas em 'processing' pra sempre (16 desde 24/07). E o reset de relógio por
-- turno (cancelar+recriar a sequência) acumulava lixo sem limite (3.726 rows
-- 'cancelled' só na conta Marcia; 130 num único contato).
--
-- Código correspondente: follow-up-scheduler.ts — claim 20→5 + time-budget 40s
-- + reaper de 'processing' órfão (>15min → 'failed'); scheduleFollowUps agora
-- DELETE nos pending + cancela processing + captura 23505 do UNIQUE abaixo.

-- (a) One-off: zumbis presos em 'processing' há mais de 1h → failed (não
-- reenvia; a lambda pode ter morrido entre o envio e o update de status).
UPDATE scheduled_followups SET status='failed'
WHERE status='processing' AND updated_at < now() - interval '1 hour';

-- (b) Purge do lixo de churn: cancelled com mais de 7 dias (audit recente fica).
DELETE FROM scheduled_followups
WHERE status='cancelled' AND updated_at < now() - interval '7 days';

-- (c) UNIQUE parcial: no máximo 1 sequência VIVA por (agent, contact, attempt).
-- Zero violações atuais (verificado em prod antes da migration). A corrida
-- delete→insert de 2 turnos simultâneos agora bate aqui (23505) e o código
-- faz retry único (latest-wins).
CREATE UNIQUE INDEX IF NOT EXISTS uq_followups_live_attempt
  ON scheduled_followups (agent_id, contact_id, attempt_number)
  WHERE status IN ('pending','processing');

-- (d) Índice pro reaper varrer 'processing' órfão barato.
CREATE INDEX IF NOT EXISTS idx_followups_processing_updated
  ON scheduled_followups (updated_at)
  WHERE status = 'processing';
