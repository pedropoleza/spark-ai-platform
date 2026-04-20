-- Previne duplicatas de webhook (GHL retry envia o mesmo message ID)
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_ghl_dedup
  ON message_queue(ghl_message_id)
  WHERE ghl_message_id IS NOT NULL;
