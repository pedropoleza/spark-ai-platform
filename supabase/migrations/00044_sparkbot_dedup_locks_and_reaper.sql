-- =============================================
-- 00044_sparkbot_dedup_locks_and_reaper
--
-- TWO CRITICAL FIXES descobertos no stress test 2026-05-03:
--
-- 1) sparkbot_dedup_locks — tabela aplicada via MCP em 2026-05-03 mas
--    NUNCA versionada. webhook-handler.ts:201 inserts neste CREATE,
--    fresh staging branches falham silenciosamente (insert error caught
--    como "não-bloqueante"), tirando a 3ª camada da defesa anti-dup
--    multi-provider. Re-criar idempotente aqui.
--
-- 2) message_queue.updated_at AUSENTE — reaper em queue/processor.ts:70
--    faz UPDATE...WHERE updated_at < cutoff numa coluna inexistente.
--    PostgREST retorna error que NÃO é capturado pelo desestruturado
--    `const { data: orphans }`. Resultado: mensagens ficam stuck em
--    `processing` para sempre se lambda morrer. Adiciona coluna +
--    trigger.
-- =============================================

-- ---- 1) sparkbot_dedup_locks ----
CREATE TABLE IF NOT EXISTS sparkbot_dedup_locks (
  dedup_key text PRIMARY KEY,
  rep_id uuid,
  content_preview text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '60 seconds')
);

CREATE INDEX IF NOT EXISTS idx_sparkbot_dedup_locks_expires
  ON sparkbot_dedup_locks(expires_at);

COMMENT ON TABLE sparkbot_dedup_locks IS
  'Anti-race window pra webhooks Sparkbot multi-provider concorrentes (Stevo + WhatsApp Business API geram 2 webhooks <100ms com messageId diferentes). PK em dedup_key=hash(rep_id+minute+content[:200]) força UNIQUE. Auto-expira em 60s. Cleanup cron abaixo.';

-- Cleanup cron (pg_cron extension assumida; se não tiver, comentar)
-- DELETE locks expirados a cada 5min
-- FIX re-validação 2026-05-03: cron.schedule não é idempotente — falha em
-- prod onde o job já foi criado via MCP. Pattern dos migrations 00032/00034:
-- unschedule existente antes de re-criar.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sparkbot-dedup-locks-cleanup') THEN
      PERFORM cron.unschedule('sparkbot-dedup-locks-cleanup');
    END IF;
    PERFORM cron.schedule(
      'sparkbot-dedup-locks-cleanup',
      '*/5 * * * *',
      $cleanup$DELETE FROM sparkbot_dedup_locks WHERE expires_at < now()$cleanup$
    );
  END IF;
END $$;

-- ---- 2) message_queue.updated_at + reaper compatibility ----
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Trigger pra manter updated_at fresh em UPDATEs
CREATE OR REPLACE FUNCTION touch_message_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_queue_updated_at ON message_queue;
CREATE TRIGGER trg_message_queue_updated_at
  BEFORE UPDATE ON message_queue
  FOR EACH ROW
  EXECUTE FUNCTION touch_message_queue_updated_at();

-- Backfill: rows existentes ganham updated_at = received_at (close enough)
UPDATE message_queue
  SET updated_at = COALESCE(received_at, created_at, now())
  WHERE updated_at IS NULL OR updated_at = '1970-01-01'::timestamptz;

COMMENT ON COLUMN message_queue.updated_at IS
  'Timestamp do último UPDATE. Usado pelo reaper em queue/processor.ts pra detectar mensagens orfãs em status=processing há >30min.';
