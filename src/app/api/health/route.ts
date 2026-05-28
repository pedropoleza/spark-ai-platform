/**
 * GET /api/health — endpoint público sem auth pra uptime monitoring (F19).
 *
 * Uptime Robot / BetterStack / Pingdom batem aqui a cada N minutos. Retorna:
 *   - 200 OK + { status: "healthy" }: tudo bem
 *   - 200 OK + { status: "warning" }: degradação parcial (signals > 5 high 24h)
 *   - 503 + { status: "degraded" }: bulk-runner stale (>5min) OU critical signal 1h
 *
 * NÃO expõe internals (counts, env vars, etc). Só status agregado. Auth público
 * é seguro pq não revela nada útil pra atacante.
 *
 * Cache-Control: no-store pra cada hit ser real-time.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STALE_THRESHOLD_SEC = 300; // 5min

export async function GET() {
  try {
    const supabase = createAdminClient();
    const [bulkRow, criticalSignals1h, highSignals24h] = await Promise.all([
      supabase.from("bulk_runner_health").select("last_tick_at, consecutive_errors").eq("id", 1).maybeSingle(),
      supabase
        .from("admin_signals")
        .select("id", { count: "exact", head: true })
        .eq("severity", "critical")
        .gte("last_seen_at", new Date(Date.now() - 60 * 60 * 1000).toISOString()),
      supabase
        .from("admin_signals")
        .select("id", { count: "exact", head: true })
        .eq("severity", "high")
        .gte("last_seen_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ]);

    const lastTick = bulkRow.data?.last_tick_at as string | null;
    const tickAge = lastTick ? Math.round((Date.now() - new Date(lastTick).getTime()) / 1000) : Infinity;
    const errStreak = (bulkRow.data?.consecutive_errors as number) ?? 0;
    const critical = criticalSignals1h.count ?? 0;
    const high = highSignals24h.count ?? 0;

    let status: "healthy" | "warning" | "degraded";
    if (critical > 0 || tickAge > STALE_THRESHOLD_SEC || errStreak >= 3) {
      status = "degraded";
    } else if (high > 5) {
      status = "warning";
    } else {
      status = "healthy";
    }

    const httpStatus = status === "degraded" ? 503 : 200;
    return NextResponse.json(
      { status, timestamp: new Date().toISOString() },
      { status: httpStatus, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { status: "degraded", error: err instanceof Error ? err.message : "unknown" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
