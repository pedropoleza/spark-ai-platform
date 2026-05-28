-- Bulk runner latency tracking (Pedro 2026-05-28 F16).
-- _planning/_gaps-prospeccao-2026-05-28: observability final.
--
-- Adiciona last_duration_ms em bulk_runner_health pra detectar degradação
-- progressiva. Hoje sabemos last_tick_at (= quando rodou) e consecutive_errors
-- (= falhas seguidas), mas latência média do tick não é visível. Se o tick
-- normalmente leva ~200ms e começar a levar 5s sem erro, é sinal de problema.

ALTER TABLE bulk_runner_health
  ADD COLUMN IF NOT EXISTS last_duration_ms INT;

COMMENT ON COLUMN bulk_runner_health.last_duration_ms IS
  'Pedro 2026-05-28: duração em ms do último tick bem-sucedido. NULL pra ticks pré-medição.';
