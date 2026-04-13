-- Pausar manualmente a IA para um contato especifico quando um operador
-- humano envia uma mensagem de encerramento (ex: "Obrigada, sigo daqui")
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_conversation_state_ai_paused
  ON conversation_state(ai_paused_at)
  WHERE ai_paused_at IS NOT NULL;
