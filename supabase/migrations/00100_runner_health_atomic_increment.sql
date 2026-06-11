-- =============================================
-- 00100_runner_health_atomic_increment
--
-- NB-7 (review 2026-06-10): o catch de `trackRunner` (runner-health.ts)
-- incrementava consecutive_errors via read-modify-write — SELECT
-- consecutive_errors → +1 em JS → UPSERT. O comment inline afirmava "não há
-- race porque single-worker (cron tick)". FALSO.
--
-- Por que é racy: o pg_cron `sparkbot-proactive` (00053) dispara a cada 30s e
-- o endpoint /api/cron/sparkbot-proactive tem maxDuration=60. O
-- pg_try_advisory_xact_lock(8675309) do cron é _xact_-scoped: solta no commit
-- da transação do pg_cron (que só enfileira um net.http_post fire-and-forget
-- via pg_net). Ele NÃO serializa as execuções do lambda Vercel. Um tick lento
-- (>30s) sobrepõe o próximo; se o MESMO runner lança nos dois, ambos liam o
-- mesmo consecutive_errors e gravam o mesmo +1 = lost update (subcontava a
-- streak, atrasando o admin_signal de >= 3 erros consecutivos que sinaliza
-- runner quebrado).
--
-- Fix: RPC atômico — INSERT .. ON CONFLICT DO UPDATE SET consecutive_errors =
-- runner_health.consecutive_errors + 1 RETURNING. O TS passa a usar o valor
-- devolvido (pós-incremento) pro check >= 3, então o signal dispara na
-- contagem real mesmo sob ticks sobrepostos.
--
-- Severity baixa: counter interno de health, sem impacto em billing/dados ou
-- cliente; self-healing no próximo tick não-sobreposto + path redundante
-- `checkBulkRunnerStaleAndAlert`. Cleanup, não urgente.
--
-- SECURITY DEFINER + search_path fixo (pg_temp por último, anti-shadow) +
-- EXECUTE travado em service_role: mesma postura defense-in-depth da 00088
-- (anon é dead code; runtime/cron rodam como service_role/postgres). Aditivo,
-- idempotente. Aplicado em prod via MCP — arquivo sempre criado (convenção).
-- =============================================

CREATE OR REPLACE FUNCTION public.increment_runner_error(
  p_runner_name TEXT,
  p_error       TEXT
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_streak INT;
BEGIN
  -- INSERT (1º erro de um runner ainda sem row = streak 1) OU incremento
  -- atômico do valor existente. `runner_health.consecutive_errors` no SET
  -- referencia a row ALVO (a existente), não a proposta EXCLUDED.
  INSERT INTO public.runner_health (
    runner_name, last_tick_at, last_status, last_error, last_error_at,
    consecutive_errors, updated_at
  )
  VALUES (
    p_runner_name, now(), 'error', p_error, now(),
    1, now()
  )
  ON CONFLICT (runner_name) DO UPDATE SET
    last_tick_at       = now(),
    last_status        = 'error',
    last_error         = p_error,
    last_error_at      = now(),
    consecutive_errors = runner_health.consecutive_errors + 1,
    updated_at         = now()
  RETURNING consecutive_errors INTO v_streak;

  RETURN v_streak;
END;
$$;

-- Defense-in-depth (igual 00088): só service_role/postgres acessam dados no
-- runtime; anon não deve poder bombar o counter.
REVOKE ALL ON FUNCTION public.increment_runner_error(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_runner_error(TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.increment_runner_error(TEXT, TEXT) IS
  'NB-7 (2026-06-10): incremento ATÔMICO de consecutive_errors no catch do trackRunner. Substitui read-modify-write racy (ticks do cron sparkbot-proactive podem sobrepor — advisory lock é xact-scoped, não serializa os lambdas). Retorna a streak pós-incremento pro check de admin_signal >= 3.';
