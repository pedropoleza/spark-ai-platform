-- =============================================
-- 00054_perf_indexes
--
-- Pedro 2026-05-05 (ULTRA-REVIEW Track 12 H1, M-perf): indexes preventivos
-- pra escala. Aplicada em prod via MCP pré-criação deste arquivo.
--
-- 1. GIN em rep_identities.ghl_users JSONB pra queries multi-location admin
--    ("qual rep tem ghl_user_id=X?"). Atual workload faz find/some em JS,
--    mas dashboards admin que crescerem com count de reps precisam server-side.
-- 2. last_inbound_at pra silence-gate reset checks (queries DESC ordenadas).
-- 3. unbilled_capready: partial index pra cron retry (alinhado com fix C2).
--    Substitui idx_usage_records_unbilled da 00040 que não filtrava cap_blocked.
-- 4. paused: partial pra silence-gate skip queries.
-- =============================================

CREATE INDEX IF NOT EXISTS idx_rep_identities_ghl_users_gin
  ON rep_identities USING GIN (ghl_users);

CREATE INDEX IF NOT EXISTS idx_rep_identities_last_inbound
  ON rep_identities(last_inbound_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_usage_records_unbilled_capready
  ON usage_records(created_at)
  WHERE charged_to_wallet = false
    AND uses_custom_key = false
    AND cap_blocked = false
    AND total_charge_usd > 0;

CREATE INDEX IF NOT EXISTS idx_rep_identities_paused
  ON rep_identities(proactive_paused_at)
  WHERE proactive_paused_at IS NOT NULL;
