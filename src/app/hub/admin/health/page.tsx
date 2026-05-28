/**
 * /hub/admin/health — UI visual do cron-health (hypercare 48h).
 *
 * Renderiza o mesmo JSON do /api/admin/cron-health mas em cards visuais.
 * Auth via SSO (session.isAdmin) — diferente do endpoint /api/admin/* que
 * usa Basic Auth. Aqui o admin já entrou no hub.
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  ShieldAlert,
  Activity,
  Megaphone,
  Layers,
  Repeat,
  Ban,
} from "lucide-react";
import { HealthAutoRefresh } from "./auto-refresh";

export const dynamic = "force-dynamic";

// Lib local (espelha /api/admin/cron-health pra evitar fetch interno em SSR).
async function loadHealth() {
  const supabase = createAdminClient();
  const flags = {
    OUTREACH_RUNNER_ENABLED: process.env.OUTREACH_RUNNER_ENABLED === "1",
    BULK_SEQUENCES_ENABLED: process.env.BULK_SEQUENCES_ENABLED === "1",
    RECURRING_CAMPAIGNS_ENABLED: process.env.RECURRING_CAMPAIGNS_ENABLED === "1",
    WEBHOOK_REQUIRE_SIGNATURE: process.env.WEBHOOK_REQUIRE_SIGNATURE === "true",
    has_ghl_webhook_secret: !!process.env.GHL_WEBHOOK_SECRET,
  };

  const [
    bulkHealth,
    jobsRunning,
    jobsPaused,
    jobsCompleted24h,
    sequenceActive,
    sequencePaused,
    recurringEnabled,
    optoutsTotal,
    outreachRuns24h,
    signalsHigh24h,
    signalsCritical24h,
    topSignals,
    runnersHealth,
  ] = await Promise.all([
    supabase.from("bulk_runner_health").select("*").eq("id", 1).maybeSingle(),
    supabase.from("bulk_message_jobs").select("id", { count: "exact", head: true }).eq("status", "running"),
    supabase.from("bulk_message_jobs").select("id", { count: "exact", head: true }).eq("status", "paused"),
    supabase.from("bulk_message_jobs").select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gte("completed_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase.from("bulk_message_sequence_state").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("bulk_message_sequence_state").select("id", { count: "exact", head: true }).eq("status", "paused_by_reply"),
    supabase.from("recurring_campaigns").select("id", { count: "exact", head: true }).eq("enabled", true),
    supabase.from("outreach_optouts").select("id", { count: "exact", head: true }),
    supabase.from("outreach_runs").select("id", { count: "exact", head: true })
      .gte("ran_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase.from("admin_signals").select("id", { count: "exact", head: true })
      .eq("severity", "high")
      .neq("status", "done")
      .neq("status", "wontfix")
      .gte("last_seen_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    supabase.from("admin_signals").select("id", { count: "exact", head: true })
      .eq("severity", "critical")
      .neq("status", "done")
      .neq("status", "wontfix")
      .gte("last_seen_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    // F15: top 5 signals high/critical pra mostrar diretamente.
    supabase.from("admin_signals")
      .select("id, type, severity, title, occurrence_count, last_seen_at, status")
      .in("severity", ["high", "critical"])
      .neq("status", "done")
      .neq("status", "wontfix")
      .order("last_seen_at", { ascending: false })
      .limit(5),
    // F17: health unificada por runner.
    supabase.from("runner_health")
      .select("runner_name, last_tick_at, last_duration_ms, last_status, consecutive_errors, last_error, last_payload")
      .order("runner_name", { ascending: true }),
  ]);

  const lastTickAt = bulkHealth.data?.last_tick_at as string | null;
  const tickAgeSeconds = lastTickAt ? Math.round((Date.now() - new Date(lastTickAt).getTime()) / 1000) : -1;
  const errStreak = (bulkHealth.data?.consecutive_errors as number) ?? 0;

  let overall: "healthy" | "warning" | "degraded" = "healthy";
  if (errStreak >= 3 || (signalsCritical24h.count ?? 0) > 0) overall = "degraded";
  else if (tickAgeSeconds < 0 || tickAgeSeconds > 300 || (signalsHigh24h.count ?? 0) > 5) overall = "warning";

  return {
    flags,
    overall,
    bulk: {
      last_tick_at: lastTickAt,
      tick_age_seconds: tickAgeSeconds,
      consecutive_errors: errStreak,
      last_fired: (bulkHealth.data?.last_fired as number) ?? 0,
      last_failed: (bulkHealth.data?.last_failed as number) ?? 0,
      last_skipped: (bulkHealth.data?.last_skipped as number) ?? 0,
      last_duration_ms: (bulkHealth.data?.last_duration_ms as number | null) ?? null,
      last_error: bulkHealth.data?.last_error as string | null,
    },
    campaigns: {
      jobs_running: jobsRunning.count ?? 0,
      jobs_paused: jobsPaused.count ?? 0,
      jobs_completed_24h: jobsCompleted24h.count ?? 0,
      sequence_active: sequenceActive.count ?? 0,
      sequence_paused_by_reply: sequencePaused.count ?? 0,
      recurring_enabled: recurringEnabled.count ?? 0,
      optouts_total: optoutsTotal.count ?? 0,
      outreach_runs_24h: outreachRuns24h.count ?? 0,
    },
    signals: {
      high_24h: signalsHigh24h.count ?? 0,
      critical_24h: signalsCritical24h.count ?? 0,
      // F15: lista direta dos top open.
      top: (topSignals.data || []) as Array<{
        id: string;
        type: string;
        severity: string;
        title: string;
        occurrence_count: number;
        last_seen_at: string;
        status: string;
      }>,
    },
    runners: (runnersHealth.data || []) as Array<{
      runner_name: string;
      last_tick_at: string | null;
      last_duration_ms: number | null;
      last_status: string;
      consecutive_errors: number;
      last_error: string | null;
      last_payload: Record<string, unknown> | null;
    }>,
  };
}

function fmtAgo(seconds: number): string {
  if (seconds < 0) return "nunca";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
}

const STATUS_LABEL = { healthy: "Saudável", warning: "Atenção", degraded: "Degradado" };
const STATUS_BG = { healthy: "#10b981", warning: "#f59e0b", degraded: "#ef4444" };

export default async function HealthPage() {
  const session = await getSession();
  if (!session) redirect("/");
  if (!session.isAdmin) redirect("/hub");

  const h = await loadHealth();
  const StatusIcon = h.overall === "healthy" ? CheckCircle2 : h.overall === "warning" ? AlertTriangle : XCircle;

  return (
    <div className="page">
      <div className="page-hd" style={{ flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="page-hd__title">
            <Activity size={20} style={{ verticalAlign: "-3px", marginRight: 6 }} />
            Health do sistema
          </h1>
          <p className="page-hd__sub">Hypercare 48h pós-cutover. Atualiza a cada refresh.</p>
        </div>
        <div
          className="row"
          style={{
            gap: 8,
            alignItems: "center",
            padding: "8px 14px",
            background: STATUS_BG[h.overall],
            color: "#fff",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          <StatusIcon size={16} />
          {STATUS_LABEL[h.overall]}
        </div>
      </div>

      {/* Flags */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-hd">
          <h3>Flags de runtime</h3>
        </div>
        <div className="card-body" style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <FlagPill label="Outreach runner" on={h.flags.OUTREACH_RUNNER_ENABLED} />
          <FlagPill label="Bulk sequences" on={h.flags.BULK_SEQUENCES_ENABLED} />
          <FlagPill label="Recurring campaigns" on={h.flags.RECURRING_CAMPAIGNS_ENABLED} />
          <FlagPill
            label="Webhook GHL assinado"
            on={h.flags.WEBHOOK_REQUIRE_SIGNATURE && h.flags.has_ghl_webhook_secret}
            warning={!h.flags.has_ghl_webhook_secret}
          />
        </div>
        {!h.flags.has_ghl_webhook_secret && (
          <div style={{ padding: "10px 16px", background: "#fef3c7", borderTop: "1px solid #f59e0b", fontSize: 12.5, color: "#78350f" }}>
            <ShieldAlert size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            <strong>Atenção:</strong> webhook GHL aceita requests sem assinatura. Gere secret no GHL Developer Portal → seta <code>GHL_WEBHOOK_SECRET</code> + <code>WEBHOOK_REQUIRE_SIGNATURE=true</code> no Vercel.
          </div>
        )}
      </div>

      {/* F17: Runners unificados (todos os 4) */}
      {h.runners.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-hd">
            <h3>Runners</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              Tick a cada 30s — sparkbot-proactive
            </span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-2)" }}>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500 }}>Runner</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500 }}>Status</th>
                  <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500 }}>Tick</th>
                  <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500 }}>Duração</th>
                  <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500 }}>Errs</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500 }}>Último payload</th>
                </tr>
              </thead>
              <tbody>
                {h.runners.map((r) => {
                  const tickAge = r.last_tick_at
                    ? Math.round((Date.now() - new Date(r.last_tick_at).getTime()) / 1000)
                    : -1;
                  const statusColor =
                    r.last_status === "error" ? "#ef4444" :
                    r.last_status === "partial" ? "#f59e0b" :
                    r.last_status === "no_op" ? "#94a3b8" :
                    "#10b981";
                  const payloadSummary = r.last_payload
                    ? Object.entries(r.last_payload as Record<string, unknown>)
                        .filter(([, v]) => typeof v === "number" && v > 0)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ") || "—"
                    : "—";
                  return (
                    <tr key={r.runner_name} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 12 }}>{r.runner_name}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{ color: statusColor, fontWeight: 500 }}>● {r.last_status}</span>
                      </td>
                      <td className="tnum" style={{ padding: "10px 12px", textAlign: "right" }}>
                        {tickAge < 0 ? "nunca" : tickAge < 60 ? `${tickAge}s` : `${Math.round(tickAge / 60)}min`}
                      </td>
                      <td className="tnum" style={{ padding: "10px 12px", textAlign: "right" }}>
                        {r.last_duration_ms !== null ? `${r.last_duration_ms}ms` : "—"}
                      </td>
                      <td className="tnum" style={{ padding: "10px 12px", textAlign: "right", color: r.consecutive_errors >= 3 ? "#ef4444" : undefined }}>
                        {r.consecutive_errors}
                      </td>
                      <td className="muted" style={{ padding: "10px 12px", fontSize: 11, fontFamily: "monospace", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {payloadSummary}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bulk runner (legacy) */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-hd">
          <h3>Bulk-runner (heartbeat)</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Singleton legado — last_tick_at, fired/failed/skipped
          </span>
        </div>
        <div className="card-body" style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16 }}>
          <Stat
            label="Último tick"
            value={fmtAgo(h.bulk.tick_age_seconds)}
            danger={h.bulk.tick_age_seconds > 300 || h.bulk.tick_age_seconds < 0}
          />
          {/* F16: latência do último tick — flag warning se > 10s */}
          <Stat
            label="Duração tick"
            value={h.bulk.last_duration_ms !== null ? `${h.bulk.last_duration_ms}ms` : "—"}
            danger={h.bulk.last_duration_ms !== null && h.bulk.last_duration_ms > 10_000}
          />
          <Stat label="Erros consecutivos" value={String(h.bulk.consecutive_errors)} danger={h.bulk.consecutive_errors >= 3} />
          <Stat label="Último envio (fired)" value={String(h.bulk.last_fired)} />
          <Stat label="Falhas" value={String(h.bulk.last_failed)} danger={h.bulk.last_failed > 0} />
          <Stat label="Skipped" value={String(h.bulk.last_skipped)} />
        </div>
        {h.bulk.last_error && (
          <div style={{ padding: "10px 16px", background: "#fee2e2", borderTop: "1px solid #ef4444", fontSize: 12, color: "#7f1d1d", fontFamily: "monospace" }}>
            <strong>Último erro:</strong> {h.bulk.last_error.slice(0, 240)}
          </div>
        )}
      </div>

      {/* Campaigns */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-hd">
          <h3>Campanhas</h3>
        </div>
        <div className="card-body" style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
          <Stat label={<><Megaphone size={12} style={{ verticalAlign: "-1px" }} /> Jobs rodando</>} value={String(h.campaigns.jobs_running)} />
          <Stat label="Jobs pausados" value={String(h.campaigns.jobs_paused)} />
          <Stat label="Completados 24h" value={String(h.campaigns.jobs_completed_24h)} />
          <Stat label={<><Layers size={12} style={{ verticalAlign: "-1px" }} /> Sequências ativas</>} value={String(h.campaigns.sequence_active)} />
          <Stat label="Pausadas por reply" value={String(h.campaigns.sequence_paused_by_reply)} />
          <Stat label={<><Repeat size={12} style={{ verticalAlign: "-1px" }} /> Recorrentes ON</>} value={String(h.campaigns.recurring_enabled)} />
          <Stat label={<><Ban size={12} style={{ verticalAlign: "-1px" }} /> Opt-outs total</>} value={String(h.campaigns.optouts_total)} />
          <Stat label="Outreach runs 24h" value={String(h.campaigns.outreach_runs_24h)} />
        </div>
      </div>

      {/* Signals */}
      <div className="card">
        <div className="card-hd">
          <h3>Signals 24h</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            <a href="/api/admin/signals" target="_blank" style={{ color: "inherit", textDecoration: "underline" }}>
              ver todos
            </a>
          </span>
        </div>
        <div className="card-body" style={{ padding: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: h.signals.top.length > 0 ? 16 : 0 }}>
            <Stat label="High severity" value={String(h.signals.high_24h)} danger={h.signals.high_24h > 5} />
            <Stat label="Critical" value={String(h.signals.critical_24h)} danger={h.signals.critical_24h > 0} />
          </div>
          {h.signals.top.length > 0 && (
            <div className="col" style={{ gap: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>
                Últimos open
              </div>
              {h.signals.top.map((s) => (
                <div
                  key={s.id}
                  style={{
                    padding: "8px 12px",
                    background: s.severity === "critical" ? "#fee2e2" : "#fef3c7",
                    borderLeft: `3px solid ${s.severity === "critical" ? "#ef4444" : "#f59e0b"}`,
                    borderRadius: 4,
                    fontSize: 12.5,
                  }}
                >
                  <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontWeight: 500, wordBreak: "break-word", flex: 1, minWidth: 0 }}>
                      {s.title}
                    </span>
                    <span className="muted tnum" style={{ fontSize: 11, flexShrink: 0 }}>
                      ×{s.occurrence_count}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {s.severity} · {new Date(s.last_seen_at).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {s.status}
                  </div>
                </div>
              ))}
            </div>
          )}
          {h.signals.top.length === 0 && h.signals.high_24h === 0 && h.signals.critical_24h === 0 && (
            <div className="muted" style={{ fontSize: 12, fontStyle: "italic", textAlign: "center", marginTop: 8 }}>
              Nenhum signal open. 🎉
            </div>
          )}
        </div>
      </div>

      <HealthAutoRefresh />
    </div>
  );
}

function FlagPill({ label, on, warning }: { label: string; on: boolean; warning?: boolean }) {
  const color = on && !warning ? "#10b981" : warning ? "#f59e0b" : "#94a3b8";
  return (
    <div className="row" style={{ gap: 8, padding: "10px 12px", border: `1px solid ${color}`, borderRadius: 6, background: `${color}22`, alignItems: "center" }}>
      {on && !warning ? (
        <ShieldCheck size={14} style={{ color }} />
      ) : warning ? (
        <ShieldAlert size={14} style={{ color }} />
      ) : (
        <XCircle size={14} style={{ color }} />
      )}
      <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
      <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
        {on && !warning ? "ATIVA" : warning ? "PARCIAL" : "DESLIGADA"}
      </span>
    </div>
  );
}

function Stat({ label, value, danger }: { label: React.ReactNode; value: string; danger?: boolean }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div className="tnum" style={{ fontSize: 22, fontWeight: 600, color: danger ? "#ef4444" : undefined, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}
