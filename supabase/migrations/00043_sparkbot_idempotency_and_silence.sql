-- =============================================
-- 00043_sparkbot_idempotency_and_silence
--
-- Aplicada em prod via MCP em 2026-05-02; arquivo versionado pra fresh
-- environments / staging branches reproduzirem o estado.
--
-- 1) Idempotency (sparkbot_messages.ghl_message_id):
--    GHL retry de webhook com mesmo messageId não pode reprocessar
--    (2x Whisper bill, 2x LLM, possível 2x resposta enviada).
--    UNIQUE INDEX parcial em ghl_message_id IS NOT NULL — null permite
--    test/synthetic msgs sem id ainda passarem.
--
-- 2) Silence tracking (rep_identities):
--    Detectar reps que param de responder e pausar proativos antes de
--    cair no banimento WhatsApp da Meta. Lógica em
--    src/lib/account-assistant/proactive/silence-gate.ts.
-- =============================================

-- Idempotency
ALTER TABLE sparkbot_messages
  ADD COLUMN IF NOT EXISTS ghl_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sparkbot_messages_ghl_msg_id
  ON sparkbot_messages(ghl_message_id)
  WHERE ghl_message_id IS NOT NULL;

COMMENT ON COLUMN sparkbot_messages.ghl_message_id IS
  'ID nativo do GHL conversations API. UNIQUE pra idempotency: GHL retry de webhook não reprocessa.';

-- Silence tracking
ALTER TABLE rep_identities
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_proactive_without_reply integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proactive_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS proactive_warned_at timestamptz;

COMMENT ON COLUMN rep_identities.last_inbound_at IS
  'Última vez que o rep mandou QUALQUER mensagem (Web UI ou WhatsApp). Reset do silence counter.';
COMMENT ON COLUMN rep_identities.consecutive_proactive_without_reply IS
  'Contador de proativos enviados desde a última inbound do rep. Threshold 2 = avisa, 3 = pausa.';
COMMENT ON COLUMN rep_identities.proactive_paused_at IS
  'Quando o bot parou de mandar proativo por silêncio do rep. Limpa em qualquer inbound.';
COMMENT ON COLUMN rep_identities.proactive_warned_at IS
  'Quando o bot avisou no 2º proativo. Pra não duplicar warning.';

-- Index pra dispatcher checar silence rapidamente (subset onde paused)
CREATE INDEX IF NOT EXISTS idx_rep_identities_proactive_paused
  ON rep_identities(proactive_paused_at)
  WHERE proactive_paused_at IS NOT NULL;
