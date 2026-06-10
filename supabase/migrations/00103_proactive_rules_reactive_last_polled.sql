-- =============================================================================
-- Migration 00103: assistant_proactive_rules.reactive_last_polled_at
-- H39 (Pedro 2026-06-10). Aditiva/segura (coluna nova com default).
--
-- Motivação:
--   O cron 'sparkbot-proactive' batia GHL /calendars/events (post_meeting
--   polling) a cada tick de 30s — ~51k calls/dia à toa. Não há sinal em DB de
--   "appointment acabou de terminar" (o dado vive no GHL), então o polling é
--   por janela de tempo. O grace de 30min do post_meeting cobre folgado uma
--   poll a cada 5min. Esta coluna guarda QUANDO a última poll rodou, pra:
--     1. o endpoint (route.ts) só pollar via claim atômico se passou >5min;
--     2. o guard do pg_cron (migration 00104) só ACORDAR o endpoint pra rule
--        reactive quando ela está poll-due — em vez de sempre, que era o que
--        tornava o EXISTS de rules sempre-verdadeiro (post_meeting fica enabled
--        em prod permanentemente).
--
--   DEFAULT epoch (1970) = toda rule existente nasce "poll-due" → polla no
--   primeiro tick após a migration, sem gap de comportamento. NOT NULL evita
--   ter que tratar IS NULL no claim (.lte) e no guard SQL.
-- =============================================================================

ALTER TABLE assistant_proactive_rules
  ADD COLUMN IF NOT EXISTS reactive_last_polled_at TIMESTAMPTZ
    NOT NULL DEFAULT '1970-01-01T00:00:00Z';

COMMENT ON COLUMN assistant_proactive_rules.reactive_last_polled_at IS
  'H39: timestamp da última poll de uma rule reactive (post_meeting). Throttle do polling GHL (claim atômico no route.ts, intervalo 5min) + gate do guard do pg_cron 00104. Ignorado por rules scheduled. Default epoch = nasce poll-due.';

-- Index parcial pro guard do pg_cron (00104): EXISTS de reactive poll-due.
-- Só rules reactive enabled interessam — index minúsculo.
CREATE INDEX IF NOT EXISTS idx_proactive_rules_reactive_poll_due
  ON assistant_proactive_rules (reactive_last_polled_at)
  WHERE enabled = true AND rule_type = 'reactive';
