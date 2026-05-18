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
} from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function OverviewTab({ data, loading }: { data: any; loading: boolean }) {
  if (loading && !data) return <SkeletonGrid />;
  if (!data) return <div className="text-muted-foreground">Sem dados</div>;

  const o = data;
  return (
    <div className="space-y-6">
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

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi
          icon={<MessageSquare className="h-4 w-4" />}
          label="Mensagens 24h"
          value={o.messages_24h.total}
          sub={`${o.messages_24h.inbound} in / ${o.messages_24h.outbound} out`}
        />
        <Kpi
          icon={<Users className="h-4 w-4" />}
          label="Reps ativos"
          value={`${o.reps.active_24h}`}
          sub={`${o.reps.active_7d} / ${o.reps.active_30d} (7d/30d) — total ${o.reps.total_external}`}
        />
        <Kpi
          icon={<Activity className="h-4 w-4" />}
          label="AI calls 24h"
          value={o.ai_24h.calls}
          sub={`${o.ai_7d.calls} em 7d`}
        />
        <Kpi
          icon={<Send className="h-4 w-4" />}
          label="Bulk jobs"
          value={o.bulk.running}
          sub={`${o.bulk.paused} paused • ${o.bulk.created_7d} criados 7d`}
        />
      </div>

      {/* Billing snapshot */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <DollarSign className="h-5 w-5 text-emerald-600" />
          <h3 className="font-semibold">Billing 24h</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Revenue</div>
            <div className="text-lg font-mono">${o.ai_24h.revenue_usd.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Cost</div>
            <div className="text-lg font-mono">${o.ai_24h.cost_usd.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Margem</div>
            <div className="text-lg font-mono">${o.ai_24h.margin_usd.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Margem %</div>
            <div className="text-lg font-mono">{o.ai_24h.margin_pct}%</div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">
          7d acumulado: <strong>${o.ai_7d.revenue_usd.toFixed(2)}</strong> revenue,{" "}
          <strong>${o.ai_7d.cost_usd.toFixed(2)}</strong> cost
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
