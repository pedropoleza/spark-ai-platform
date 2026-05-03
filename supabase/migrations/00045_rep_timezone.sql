-- =============================================
-- 00045_rep_timezone
--
-- Bug observado em prod 2026-05-03: bot agendou lembrete pra "11:18 AM" em vez
-- de "12:18 PM" porque pegou o timezone da location (America/New_York), mas
-- Pedro (rep BR) está em America/Sao_Paulo. O timezone correto da hora é o
-- DO REP, não o da location — duas pessoas operando a mesma location podem
-- estar em fusos diferentes.
--
-- GHL retorna o timezone do USER no objeto users (campo `timezone` IANA), e
-- esse é o single source of truth do horário do rep. Adicionamos coluna
-- top-level pra resolver fácil em runtime; e mantemos também o timezone
-- dentro de ghl_users[] pra reps multi-location (cada user-location pode
-- ter timezone próprio teoricamente, embora na prática seja sempre o mesmo).
--
-- Resolução em runtime (processor + dispatcher):
--   rep.timezone || location.timezone || 'America/New_York'
-- =============================================

ALTER TABLE rep_identities
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN rep_identities.timezone IS
  'Timezone IANA do rep (vem do GHL user object). Usado pra calcular ISO 8601 de schedule_reminder, formatar horários no prompt e no runtime context. Fallback: location.timezone → America/New_York.';

-- Index não necessário — timezone é lido junto com o rep, não filtrado.
