-- =============================================
-- 00046_rep_timezone_confirm
--
-- Pedro (2026-05-03) refinou a abordagem do bug do lembrete: GHL user object
-- tem campo timezone, mas user pode estar viajando OU a config do GHL pode
-- estar errada. Confiar silenciosamente é frágil.
--
-- Solução: GHL.user.timezone vira SUGESTÃO (não auto-confirma). Antes de
-- chamar a primeira tool tz-sensitive (schedule_reminder, create_appointment,
-- create/update_task/update_appointment com due/start), bot PERGUNTA o fuso
-- ao rep. Confirmação fica registrada via `timezone_confirmed_at` — depois
-- disso, próximas tools de horário rodam direto.
--
-- Reset: rep diz "muda meu timezone pra X" → bot chama confirm_rep_timezone
-- com novo IANA (atualiza timezone + timezone_confirmed_at).
-- =============================================

ALTER TABLE rep_identities
  ADD COLUMN IF NOT EXISTS timezone_confirmed_at timestamptz;

COMMENT ON COLUMN rep_identities.timezone_confirmed_at IS
  'Timestamp da confirmação do timezone pelo próprio rep (via tool confirm_rep_timezone). NULL = sugestão automática (vinda do GHL user.timezone ou location.timezone) ainda NÃO confirmada — gate em executeTool bloqueia tools tz-sensitive até confirmar. Reset quando rep informa novo fuso (viagem etc).';
