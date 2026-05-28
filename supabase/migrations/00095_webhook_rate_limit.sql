-- Webhook rate limit + anomaly detection (Pedro 2026-05-28 F20 — Opção A).
--
-- GHL webhook usa chave PÚBLICA Ed25519 pra assinar (não secret HMAC), então
-- meu código de signature original estava errado em design. Em vez de
-- implementar Ed25519 verification agora, Pedro escolheu mitigações defensivas:
--   1. Rate limit por IP (50 req/min)
--   2. Cost circuit breaker (bloqueia webhook quando cap atingido)
--   3. Anomaly signal: location com >5 IPs únicos em 1min
--
-- Tabela:
--   - webhook_rate_limit_hits: cada hit do webhook (ip, location_id, ts)
--   - Sliding window 1min via cleanup periódico

CREATE TABLE IF NOT EXISTS webhook_rate_limit_hits (
  id          BIGSERIAL PRIMARY KEY,
  ip          TEXT NOT NULL,
  location_id TEXT,
  hit_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes pro lookup rolling-window (last 60s).
CREATE INDEX IF NOT EXISTS idx_webhook_hits_ip_recent
  ON webhook_rate_limit_hits(ip, hit_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_hits_location_recent
  ON webhook_rate_limit_hits(location_id, hit_at DESC) WHERE location_id IS NOT NULL;

-- Cleanup: deleta hits >5min (TTL implícito). Mais barato que partitioning
-- pra esse volume (~50 req/min/location ~ 100k rows/dia worst case).
-- Pedro: rodar via cron diário ou trigger after-insert?
-- Atalho MVP: comando manual via SQL ou cron periódico. Sem trigger pra
-- evitar overhead em cada insert.

ALTER TABLE webhook_rate_limit_hits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON webhook_rate_limit_hits;
CREATE POLICY deny_anon_all ON webhook_rate_limit_hits AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

COMMENT ON TABLE webhook_rate_limit_hits IS
  'Pedro 2026-05-28: hits do webhook GHL pra rate limit (sliding window 1min) + anomaly detect (multi-IP).';
