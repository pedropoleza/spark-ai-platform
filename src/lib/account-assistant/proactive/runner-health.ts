/**
 * Runner health tracker unificado (Pedro 2026-05-28 F17).
 *
 * Substitui bulk_runner_health (que era singleton) por uma tabela genérica
 * runner_health onde cada runner reporta seu tick. UI /hub/admin/health
 * mostra linha por runner.
 *
 * Uso:
 *   const result = await trackRunner("sequence-runner", async () => {
 *     return processSequenceSteps(); // retorna { advanced, completed, failed, ... }
 *   });
 *
 * Captura:
 *   - duration_ms (Date.now() início vs fim)
 *   - status: 'ok' | 'no_op' | 'error' | 'partial'
 *     • 'error': fn lançou exceção (consecutive_errors++)
 *     • 'partial': result tem campo `failed` > 0 ou `errors` > 0
 *     • 'no_op': result com todos zeros (runner não tinha trabalho)
 *     • 'ok': sucesso com algum trabalho feito
 *   - last_payload: snapshot do result pra UI mostrar último throughput
 *   - consecutive_errors: streak (reseta em ok/no_op/partial)
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Counters = Record<string, number | string | null>;

function classifyStatus(result: unknown): "ok" | "no_op" | "partial" {
  if (!result || typeof result !== "object") return "ok";
  const r = result as Record<string, unknown>;
  const failed = typeof r.failed === "number" ? r.failed : 0;
  const errors = typeof r.errors === "number" ? r.errors : 0;
  if (failed > 0 || errors > 0) return "partial";
  // Sum de campos comuns. Se zero = no_op.
  const sum =
    (typeof r.fired === "number" ? r.fired : 0) +
    (typeof r.created === "number" ? r.created : 0) +
    (typeof r.advanced === "number" ? r.advanced : 0) +
    (typeof r.completed === "number" ? r.completed : 0) +
    (typeof r.scanned === "number" ? r.scanned : 0);
  return sum > 0 ? "ok" : "no_op";
}

export async function trackRunner<T>(
  runnerName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const supabase = createAdminClient();
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    const status = classifyStatus(result);
    const payload: Counters = {};
    if (result && typeof result === "object") {
      for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
        if (typeof v === "number" || typeof v === "string" || v === null) {
          payload[k] = v as number | string | null;
        }
      }
    }
    // Atomic upsert. Em 'no_op' não reseta consecutive_errors (não é sucesso
    // ativo, só ausência de trabalho). Em 'ok' ou 'partial' reseta.
    const resetErrors = status === "ok" || status === "partial";
    await supabase
      .from("runner_health")
      .upsert(
        {
          runner_name: runnerName,
          last_tick_at: new Date().toISOString(),
          last_duration_ms: durationMs,
          last_status: status,
          ...(resetErrors ? { consecutive_errors: 0 } : {}),
          last_payload: payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "runner_name" },
      );
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message.slice(0, 500) : String(err);
    // Incrementa consecutive_errors ATOMICAMENTE no DB via RPC
    // (increment_runner_error: INSERT .. ON CONFLICT DO UPDATE SET
    // consecutive_errors = ...+1 RETURNING).
    // NB-7 (review 2026-06-10): antes era SELECT + UPSERT (read-modify-write)
    // com comment afirmando "single-worker (cron tick)" — FALSO. O pg_cron
    // sparkbot-proactive (00053) dispara a cada 30s e o
    // pg_try_advisory_xact_lock(8675309) é _xact_-scoped: solta no commit do
    // tick (que só enfileira um net.http_post fire-and-forget via pg_net), NÃO
    // serializa os lambdas Vercel (maxDuration=60). Tick lento (>30s) sobrepõe
    // o seguinte; se o mesmo runner lança nos dois, ambos liam o mesmo
    // consecutive_errors e gravam o mesmo +1 = lost update (subcontava a
    // streak, atrasando o admin_signal de >= 3). Increment atômico elimina.
    const { data: streak, error: rpcError } = await supabase.rpc(
      "increment_runner_error",
      { p_runner_name: runnerName, p_error: errMsg },
    );
    if (rpcError) {
      console.error(
        `[runner-health] increment_runner_error RPC falhou (${runnerName}):`,
        rpcError.message,
      );
    }
    // 3+ erros seguidos = admin_signal. Usa o valor PÓS-incremento devolvido
    // pela RPC (streak real mesmo sob ticks sobrepostos). Fingerprint dedup
    // colapsa em 1 row por runner. Pedro vê no /hub/admin/health card de signals.
    const streakCount = typeof streak === "number" ? streak : 0;
    if (streakCount >= 3) {
      try {
        const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
        recordSignalAsync({
          type: "error",
          source: "bot_auto",
          severity: "high",
          title: `${runnerName}: ${streakCount} erros consecutivos`,
          description: errMsg.slice(0, 500),
          metadata: { runner: runnerName, consecutive_errors: streakCount },
        });
      } catch {
        /* não-fatal */
      }
    }
    // Re-lança pra fluxo do cron tratar (catch upstream)
    throw err;
  }
}
