-- Rastreia notas de resumo por segmento de conversa.
-- summary_note_id NULL = sem nota gerada (dedup flag).
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS summary_note_id TEXT,
  ADD COLUMN IF NOT EXISTS summary_note_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS segment_number INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_conv_state_inactivity_scan
  ON conversation_state(status, last_ai_response_at)
  WHERE status = 'active'
    AND summary_note_id IS NULL;
