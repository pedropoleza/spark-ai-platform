/**
 * GET /api/admin/cron-health (Etapa hypercare — Pedro 2026-05-28).
 *
 * Pedro abre durante hypercare 48h pra ver, num só lugar:
 *   - Flags ativas (OUTREACH_RUNNER, BULK_SEQUENCES, RECURRING_CAMPAIGNS)
 *   - Bulk-runner health (last_tick_at, error streak, counts)
 *   - Prospecção counts (jobs, sequence_state, recurring, optouts)
 *   - Signals high/critical últimas 24h
 *   - Cron tick mais recente em sparkbot-proactive
 *
 * Auth via middleware Basic Auth (ADMIN_PANEL_PASSWORD).
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createAdminClient();

  const flags = {
    OUTREACH_RUNNER_ENABLED: process.env.OUTREACH_RUNNER_ENABLED === "1",
    BULK_SEQUENCES_ENABLED: process.env.BULK_SEQUENCES_ENABLED === "1",
    RECURRING_CAMPAIGNS_ENABLED: process.env.RECURRING_CAMPAIGNS_ENABLED === "1",
    WEBHOOK_REQUIRE_SIGNATURE: process.env.WEBHOOK_REQUIRE_SIGNATURE === "true",
    has_ghl_webhook_secret: !!process.env.GHL_WEBHOOK_SECRET,
    AGENT_MOTOR_UNIFIED: process.env.AGENT_MOTOR_UNIFIED === "1",
    AGENT_ENTITLEMENTS_ENFORCED: process.env.AGENT_ENTITLEMENTS_ENFORCED === "1",
  };

  const [
    bulkHealth,
    jobsRunning,
    jobsPaused,
    jobsCompleted24h,
    sequenceActive,
    sequencePaused,
    recurringEnabled,
    recurringDisabled,
    optoutsTotal,
    outreachRuns24h,
    signalsHigh24h,
    signalsCritical24h,
    runnersHealth,
  ] = await Promise.all([
    supabase.from("bulk_runner_health").select("*").eq("id", 1).maybeSingle(),
    supabase.from("bulk_message_jobs").select("id", { count: "exact", head: true }).eq("status", "running"),
    supabase.from("bulk_message_jobs").select("id", { count: "exact", head: true }).eq("status", "paused"),
    supabase
      .from("bulk_message_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gte("completed_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase.from("bulk_message_sequence_state").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("bulk_message_sequence_state").select("id", { count: "exact", head: true }).eq("status", "paused_by_reply"),
    supabase.from("recurring_campaigns").select("id", { count: "exact", head: true }).eq("enabled", true),
    supabase.from("recurring_campaigns").select("id", { count: "exact", head: true }).eq("enabled", false),
    supabase.from("outreach_optouts").select("id", { count: "exact", head: true }),
    supabase
      .from("outreach_runs")
      .select("id", { count: "exact", head: true })
      .gte("ran_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase
      .from("admin_signals")
      .select("id", { count: "exact", head: true })
      .eq("severity", "high")
      .gte("last_seen_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase
      .from("admin_signals")
      .select("id", { count: "exact", head: true })
      .eq("severity", "critical")
      .gte("last_seen_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    // F17: runner_health unificada.
    supabase
      .from("runner_health")
      .select("runner_name, last_tick_at, last_duration_ms, last_status, consecutive_errors, last_payload"),
  ]);

  // Status de saúde global
  const now = Date.now();
  const lastTick = bulkHealth.data?.last_tick_at ? new Date(bulkHealth.data.last_tick_at as string).getTime() : 0;
  const tickStaleness = lastTick ? Math.round((now - lastTick) / 1000) : -1;
  const tickHealthy = tickStaleness >= 0 && tickStaleness < 300; // < 5min OK

  const errStreak = (bulkHealth.data?.consecutive_errors as number) ?? 0;

  let overallStatus: "healthy" | "warning" | "degraded";
  if (errStreak >= 3 || (signalsCritical24h.count ?? 0) > 0) {
    overallStatus = "degraded";
  } else if (!tickHealthy || (signalsHigh24h.count ?? 0) > 5) {
    overallStatus = "warning";
  } else {
    overallStatus = "healthy";
  }

  return NextResponse.json(
    {
      ok: true,
      generated_at: new Date().toISOString(),
      overall_status: overallStatus,
      flags,
      bulk_runner: {
        last_tick_at: bulkHealth.data?.last_tick_at ?? null,
        tick_age_seconds: tickStaleness,
        tick_healthy: tickHealthy,
        consecutive_errors: errStreak,
        last_fired: bulkHealth.data?.last_fired ?? 0,
        last_failed: bulkHealth.data?.last_failed ?? 0,
        last_skipped: bulkHealth.data?.last_skipped ?? 0,
        last_duration_ms: bulkHealth.data?.last_duration_ms ?? null,
        last_error: bulkHealth.data?.last_error ?? null,
        last_error_at: bulkHealth.data?.last_error_at ?? null,
      },
      campaigns: {
        jobs_running: jobsRunning.count ?? 0,
        jobs_paused: jobsPaused.count ?? 0,
        jobs_completed_24h: jobsCompleted24h.count ?? 0,
        sequence_active: sequenceActive.count ?? 0,
        sequence_paused_by_reply: sequencePaused.count ?? 0,
        recurring_enabled: recurringEnabled.count ?? 0,
        recurring_disabled: recurringDisabled.count ?? 0,
        optouts_total: optoutsTotal.count ?? 0,
        outreach_runs_24h: outreachRuns24h.count ?? 0,
      },
      signals: {
        high_24h: signalsHigh24h.count ?? 0,
        critical_24h: signalsCritical24h.count ?? 0,
      },
      runners: runnersHealth.data || [],
      hints: {
        webhook_security: flags.has_ghl_webhook_secret && flags.WEBHOOK_REQUIRE_SIGNATURE
          ? "✅ GHL signature obrigatória"
          : "⚠️ Webhook GHL aceita requests sem assinatura (gere secret no GHL Developer Portal)",
        prospeccao_status:
          flags.OUTREACH_RUNNER_ENABLED && flags.BULK_SEQUENCES_ENABLED && flags.RECURRING_CAMPAIGNS_ENABLED
            ? "✅ 3 runners ativos"
            : "Algum runner OFF — confira flags",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
