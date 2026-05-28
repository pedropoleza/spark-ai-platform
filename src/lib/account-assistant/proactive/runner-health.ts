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
    // Incrementa consecutive_errors atomicamente. Faz SELECT + UPDATE — não há
    // race aqui porque single-worker (cron tick).
    const { data: cur } = await supabase
      .from("runner_health")
      .select("consecutive_errors")
      .eq("runner_name", runnerName)
      .maybeSingle();
    const streak = ((cur?.consecutive_errors as number) ?? 0) + 1;
    await supabase
      .from("runner_health")
      .upsert(
        {
          runner_name: runnerName,
          last_tick_at: new Date().toISOString(),
          last_status: "error",
          last_error: errMsg,
          last_error_at: new Date().toISOString(),
          consecutive_errors: streak,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "runner_name" },
      );
    // 3+ erros seguidos = admin_signal. Fingerprint dedup colapsa em 1 row
    // por runner. Pedro vê no /hub/admin/health card de signals.
    if (streak >= 3) {
      try {
        const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
        recordSignalAsync({
          type: "error",
          source: "bot_auto",
          severity: "high",
          title: `${runnerName}: ${streak} erros consecutivos`,
          description: errMsg.slice(0, 500),
          metadata: { runner: runnerName, consecutive_errors: streak },
        });
      } catch {
        /* não-fatal */
      }
    }
    // Re-lança pra fluxo do cron tratar (catch upstream)
    throw err;
  }
}
