"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface ActionRow {
  action: string;
  calls: number;
  unique_locations: number;
  revenue: number;
}
interface FilterTool {
  tool: string;
  executions: number;
  unique_locations: number;
}
interface ProactiveStat {
  rule: string;
  enabled: number;
  disabled: number;
}
interface FeaturesData {
  top_actions: ActionRow[];
  filter_engine: { total_executions: number; by_tool: FilterTool[] };
  bulk_adoption: { total_jobs_7d: number; multi_segment_jobs: number; unique_locations: number };
  proactive_rules: ProactiveStat[];
}

export function FeaturesTab({
  data,
  loading,
}: {
  data: FeaturesData | undefined;
  loading: boolean;
}) {
  if (loading && !data) return <Skeleton className="h-96" />;
  if (!data) return <div className="text-muted-foreground">Sem dados</div>;

  const maxCalls = Math.max(...data.top_actions.map((a) => a.calls), 1);

  return (
    <div className="space-y-6">
      {/* Top actions/tools usadas */}
      <Card className="p-4">
        <h3 className="font-semibold mb-1">🛠️ Top tools / ações (últimos 7d)</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Frequência de cada operação que dispara billing
        </p>
        <div className="space-y-1">
          {data.top_actions.length === 0 && (
            <div className="text-sm text-muted-foreground">Sem uso nos últimos 7 dias</div>
          )}
          {data.top_actions.map((a) => (
            <div key={a.action} className="flex items-center gap-2 text-xs">
              <div className="w-48 truncate font-mono">{a.action}</div>
              <div className="flex-1 relative h-5 bg-muted rounded overflow-hidden">
                <div
                  className="absolute h-full bg-blue-400"
                  style={{ width: `${(a.calls / maxCalls) * 100}%` }}
                />
                <span className="absolute inset-0 flex items-center px-2 font-mono">
                  {a.calls} calls
                </span>
              </div>
              <div className="w-20 text-right text-muted-foreground">{a.unique_locations} locs</div>
              <div className="w-24 text-right font-mono text-emerald-600">
                ${a.revenue.toFixed(4)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Filter Engine + Bulk + Proactive (3 cards lado a lado) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <h3 className="font-semibold mb-1">🔍 Filter Engine</h3>
          <p className="text-xs text-muted-foreground mb-3">execuções nos últimos 7d</p>
          <div className="text-3xl font-bold mb-3">{data.filter_engine.total_executions}</div>
          <div className="space-y-1 text-xs">
            {data.filter_engine.by_tool.slice(0, 6).map((t) => (
              <div key={t.tool} className="flex justify-between">
                <span className="font-mono truncate max-w-[60%]">{t.tool}</span>
                <span className="text-muted-foreground">
                  {t.executions}× ({t.unique_locations} locs)
                </span>
              </div>
            ))}
            {data.filter_engine.by_tool.length === 0 && (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold mb-1">📨 Bulk Adoption</h3>
          <p className="text-xs text-muted-foreground mb-3">últimos 7d</p>
          <div className="text-3xl font-bold mb-3">{data.bulk_adoption.total_jobs_7d}</div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span>Multi-segment</span>
              <Badge variant="secondary">{data.bulk_adoption.multi_segment_jobs}</Badge>
            </div>
            <div className="flex justify-between">
              <span>Locations únicas</span>
              <Badge variant="secondary">{data.bulk_adoption.unique_locations}</Badge>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold mb-1">⚡ Proactive Rules</h3>
          <p className="text-xs text-muted-foreground mb-3">configurações ativas</p>
          <div className="space-y-1 text-xs">
            {data.proactive_rules.slice(0, 8).map((p) => (
              <div key={p.rule} className="flex justify-between items-center">
                <span className="font-mono truncate max-w-[60%]">{p.rule}</span>
                <div className="flex gap-1">
                  <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">{p.enabled}</Badge>
                  {p.disabled > 0 && (
                    <Badge variant="secondary" className="text-[10px]">
                      -{p.disabled}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
            {data.proactive_rules.length === 0 && (
              <span className="text-muted-foreground">Nenhuma regra cadastrada</span>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
