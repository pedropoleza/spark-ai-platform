-- =====================================================================
-- 00065 — Bulk Management Hub (Fase 2 do plano bulk-management-platform).
-- =====================================================================
-- Pedro 2026-05-16: 7 tools novas pra rep gerenciar múltiplos disparos
-- via WhatsApp sem precisar abrir admin panel:
--   - bulk_dashboard       (safe)
--   - bulk_pause_all       (medium)
--   - bulk_resume_all      (medium)
--   - bulk_cancel_all      (high)
--   - bulk_reschedule_job  (medium)
--   - bulk_edit_pending_job (high)
--   - bulk_request_cap_override (high)
--
-- Mudanças schema:
-- 1. Nova table `bulk_cap_overrides` — audit de overrides do cap diário
-- 2. Colunas novas em `bulk_message_jobs`: paused_at, cancelled_reason,
--    cap_override_id (FK)

-- =====================================================================
-- bulk_cap_overrides
-- =====================================================================
-- Quando rep pede pra mandar mais que o cap diário, cria row aqui.
-- getDailyCap() consulta pra somar extras do dia.
-- Hard ceiling: cap_after <= cap_before * 3 (enforced em código).

CREATE TABLE IF NOT EXISTS bulk_cap_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_identity_id UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL,
  agent_id UUID REFERENCES agents(id),
  for_date DATE NOT NULL,            -- override aplica a qual dia (date local ET)
  cap_before INT NOT NULL,           -- ex: 100
  cap_after INT NOT NULL,            -- ex: 250
  extra_granted INT NOT NULL,        -- ex: 150
  reason TEXT,                       -- texto do rep ('urgente, campanha BF')
  approved_by TEXT DEFAULT 'rep',    -- 'rep' | 'admin'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_cap_overrides_location_date
  ON bulk_cap_overrides (location_id, for_date);
CREATE INDEX IF NOT EXISTS idx_bulk_cap_overrides_rep_created
  ON bulk_cap_overrides (rep_identity_id, created_at DESC);

COMMENT ON TABLE bulk_cap_overrides IS
  'Pedro 2026-05-16: audit de overrides do cap diário pedidos pelo rep ' ||
  'via tool bulk_request_cap_override. Hard ceiling 3x default em código.';

-- =====================================================================
-- bulk_message_jobs — colunas novas
-- =====================================================================

ALTER TABLE bulk_message_jobs
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_reason TEXT,
  ADD COLUMN IF NOT EXISTS cap_override_id UUID REFERENCES bulk_cap_overrides(id);

CREATE INDEX IF NOT EXISTS idx_bulk_message_jobs_rep_status
  ON bulk_message_jobs (rep_id, status);

COMMENT ON COLUMN bulk_message_jobs.paused_at IS
  'Timestamp do último pause (pra calcular pause duration em métricas)';
COMMENT ON COLUMN bulk_message_jobs.cancelled_reason IS
  'Free-text: motivo do cancel (ex: "rep pediu pause em massa", "cap atingido")';
COMMENT ON COLUMN bulk_message_jobs.cap_override_id IS
  'Se job criado com cap override, referencia a row de audit em bulk_cap_overrides';
