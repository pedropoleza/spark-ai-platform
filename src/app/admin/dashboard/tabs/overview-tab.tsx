"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  MessageSquare,
  DollarSign,
  Send,
  AlertTriangle,
  Activity,
  TrendingUp,
  Percent,
} from "lucide-react";

// Formata o range do período (o.period.from/to ISO) num rótulo curto pt-BR.
function formatPeriod(period?: { from?: string; to?: string }): string {
  if (!period?.from || !period?.to) return "";
  const f = new Date(period.from);
  const t = new Date(period.to);
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return "";
  const spanH = (t.getTime() - f.getTime()) / (60 * 60 * 1000);
  const fmtDate = (d: Date) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const fmtDateTime = (d: Date) =>
    d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  // Janelas curtas (≤48h) no mesmo intervalo → mostra hora; senão só datas.
  if (spanH <= 48) return `${fmtDateTime(f)} → ${fmtDateTime(t)}`;
  return `${fmtDate(f)} → ${fmtDate(t)}`;
}

// Cor do badge da taxa de resposta. Thresholds gentis (fácil de ajustar):
// ≥60% saudável, 30–60% atenção, <30% reps indo pro vácuo.
function responseRateBadge(pct: number): string {
  if (pct >= 60) return "bg-emerald-100 text-emerald-700";
  if (pct >= 30) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function OverviewTab({ data, loading }: { data: any; loading: boolean }) {
  if (loading && !data) return <SkeletonGrid />;
  if (!data) return <div className="text-muted-foreground">Sem dados</div>;

  const o = data;
  const periodLabel = formatPeriod(o.period);
  return (
    <div className="space-y-6">
      {periodLabel && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-medium">
            Período: {periodLabel}
          </span>
          <span>· mensagens, AI, reps ativos e taxa de resposta refletem este intervalo</span>
        </div>
      )}

      {/* Alerts críticos */}
      {(o.runner?.is_stale || o.signals?.high_open > 0 || o.runner?.consecutive_errors >= 3) && (
        <Card className="p-4 border-red-200 bg-red-50">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <h3 className="font-semibold text-red-900">Alertas críticos</h3>
          </div>
          <div className="space-y-1 text-sm text-red-800">
            {o.runner?.is_stale && (
              <div>
                ⚠️ Bulk runner stale há {Math.floor((o.runner.tick_age_seconds ?? 0) / 60)}min
              </div>
            )}
            {o.runner?.consecutive_errors >= 3 && (
              <div>
                ⚠️ Runner com {o.runner.consecutive_errors} erros consecutivos.{" "}
                {o.runner.last_error?.slice(0, 100)}
              </div>
            )}
            {o.signals?.high_open > 0 && (
              <div>
                ⚠️ {o.signals.high_open} signal{o.signals.high_open > 1 ? "s" : ""} HIGH abertos —
                ver aba Signals
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Taxa de resposta — destaque (Pedro 2026-05-21) */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-2 text-muted-foreground">
          <span className="text-xs uppercase tracking-wide flex items-center gap-1.5">
            <Percent className="h-4 w-4" /> Taxa de resposta dos reps
          </span>
          {o.response_rate?.reached > 0 && (
            <Badge className={responseRateBadge(o.response_rate.pct)}>
              {o.response_rate.pct}%
            </Badge>
          )}
        </div>
        <div className="text-3xl font-bold">
          {o.response_rate?.reached > 0 ? `${o.response_rate.pct}%` : "—"}
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {o.response_rate?.reached > 0
            ? `${o.response_rate.responded} de ${o.response_rate.reached} reps alcançados responderam no período`
            : "Nenhum rep alcançado no período"}
          {" • "}
          {o.messages.inbound} in / {o.messages.outbound} out
        </div>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi
          icon={<MessageSquare className="h-4 w-4" />}
          label="Mensagens"
          value={o.messages.total}
          sub={`${o.messages.inbound} in / ${o.messages.outbound} out`}
        />
        <Kpi
          icon={<Users className="h-4 w-4" />}
          label="Reps ativos"
          value={`${o.reps.active}`}
          sub={`${o.reps.reached} alcançados pelo bot — total ${o.reps.total_external}`}
        />
        <Kpi
          icon={<Activity className="h-4 w-4" />}
          label="AI calls"
          value={o.ai.calls}
          sub={`$${o.ai.cost_usd.toFixed(2)} custo no período`}
        />
        <Kpi
          icon={<Send className="h-4 w-4" />}
          label="Bulk jobs"
          value={o.bulk.running}
          sub={`${o.bulk.paused} paused • ${o.bulk.created} criados no período`}
        />
      </div>

      {/* Billing snapshot */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <DollarSign className="h-5 w-5 text-emerald-600" />
          <h3 className="font-semibold">Billing (período)</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Revenue</div>
            <div className="text-lg font-mono">${o.ai.revenue_usd.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Cost</div>
            <div className="text-lg font-mono">${o.ai.cost_usd.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Margem</div>
            <div className="text-lg font-mono">${o.ai.margin_usd.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Margem %</div>
            <div className="text-lg font-mono">{o.ai.margin_pct}%</div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">
          <strong>{o.ai.calls}</strong> AI calls no período
        </div>
      </Card>

      {/* Runner health */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-blue-600" />
            <h3 className="font-semibold">Bulk Runner Health</h3>
          </div>
          {o.runner.is_stale ? (
            <Badge variant="destructive">STALE</Badge>
          ) : (
            <Badge className="bg-emerald-100 text-emerald-700">OK</Badge>
          )}
        </div>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Última tick</div>
            <div className="font-mono">
              {o.runner.tick_age_seconds !== null
                ? o.runner.tick_age_seconds < 60
                  ? `${o.runner.tick_age_seconds}s ago`
                  : `${Math.floor(o.runner.tick_age_seconds / 60)}min ago`
                : "n/d"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Erros consecutivos</div>
            <div className="font-mono">{o.runner.consecutive_errors}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Signals open</div>
            <div className="font-mono">
              {o.signals.open}{" "}
              {o.signals.high_open > 0 && (
                <span className="text-red-600">({o.signals.high_open} high)</span>
              )}
            </div>
          </div>
        </div>
        {o.runner.last_error && (
          <div className="mt-2 text-xs text-amber-700 bg-amber-50 p-2 rounded">
            Last error: {o.runner.last_error.slice(0, 200)}
          </div>
        )}
      </Card>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2 text-muted-foreground">
        <span className="text-xs uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </Card>
  );
}

function SkeletonGrid() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
  );
}
