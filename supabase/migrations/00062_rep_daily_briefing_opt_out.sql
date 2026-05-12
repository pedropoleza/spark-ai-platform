-- 00062: Adiciona flag de opt-out do daily briefing por rep.
-- Pedro 2026-05-12: rep pode dizer "para de mandar resumo matinal" e bot
-- registra opt-out via tool set_daily_briefing(enabled=false). Default
-- true pra reps existentes (entram automaticamente quando rule habilitar).

ALTER TABLE rep_identities
ADD COLUMN IF NOT EXISTS daily_briefing_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN rep_identities.daily_briefing_enabled IS
  'Opt-in/opt-out do Resumo matinal diario (8h tz local). Rep pode pedir parar via tool set_daily_briefing. Default TRUE.';
