"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface DailyRow {
  day: string;
  revenue: number;
  cost: number;
  margin: number;
  calls: number;
}
interface LocationRow {
  location_id: string;
  revenue: number;
  cost: number;
  calls: number;
  charged: number;
  pending: number;
}

interface BillingData {
  daily: DailyRow[];
  top_locations: LocationRow[];
  totals: { charged_14d: number; pending_14d: number; pending_count: number };
}

export function BillingTab({ data, loading }: { data: BillingData | undefined; loading: boolean }) {
  if (loading && !data) return <Skeleton className="h-96" />;
  if (!data) return <div className="text-muted-foreground">Sem dados</div>;

  const maxRevenue = Math.max(...data.daily.map((d) => d.revenue), 0.0001);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Charged 14d</div>
          <div className="text-2xl font-bold text-emerald-600">${data.totals.charged_14d.toFixed(2)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Pending</div>
          <div className="text-2xl font-bold text-amber-600">${data.totals.pending_14d.toFixed(2)}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {data.totals.pending_count} record{data.totals.pending_count !== 1 ? "s" : ""}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">% Recuperado</div>
          <div className="text-2xl font-bold">
            {data.totals.charged_14d + data.totals.pending_14d > 0
              ? Math.round(
                  (data.totals.charged_14d / (data.totals.charged_14d + data.totals.pending_14d)) * 100,
                )
              : 100}
            %
          </div>
        </Card>
      </div>

      {/* Daily chart */}
      <Card className="p-4">
        <h3 className="font-semibold mb-4">Revenue × Cost (últimos 14d)</h3>
        <div className="space-y-1.5">
          {data.daily.length === 0 && (
            <div className="text-sm text-muted-foreground">Sem dados nos últimos 14 dias</div>
          )}
          {data.daily.map((d) => (
            <div key={d.day} className="flex items-center gap-2 text-xs">
              <div className="w-20 text-muted-foreground font-mono">{d.day.slice(5)}</div>
              <div className="flex-1 relative h-6 bg-muted rounded overflow-hidden">
                <div
                  className="absolute h-full bg-emerald-400"
                  style={{ width: `${(d.revenue / maxRevenue) * 100}%` }}
                />
                <div
                  className="absolute h-full bg-red-400 opacity-60"
                  style={{ width: `${(d.cost / maxRevenue) * 100}%` }}
                />
                <span className="absolute inset-0 flex items-center px-2 text-xs font-mono">
                  ${d.revenue.toFixed(4)} ({d.calls} calls)
                </span>
              </div>
              <div className="w-20 text-right font-mono text-emerald-600">
                +${d.margin.toFixed(4)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t text-xs text-muted-foreground flex gap-4">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-emerald-400"></span> Revenue
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-red-400 opacity-60"></span> Cost
          </span>
        </div>
      </Card>

      {/* Top locations */}
      <Card className="p-4">
        <h3 className="font-semibold mb-3">Top 10 locations (revenue 14d)</h3>
        <div className="space-y-1.5">
          <div className="grid grid-cols-6 gap-2 text-xs uppercase text-muted-foreground border-b pb-2">
            <div className="col-span-2">Location ID</div>
            <div className="text-right">Calls</div>
            <div className="text-right">Revenue</div>
            <div className="text-right">Charged</div>
            <div className="text-right">Pending</div>
          </div>
          {data.top_locations.map((loc) => (
            <div key={loc.location_id} className="grid grid-cols-6 gap-2 text-xs items-center py-1">
              <div className="col-span-2 font-mono truncate">{loc.location_id}</div>
              <div className="text-right">{loc.calls}</div>
              <div className="text-right font-mono">${loc.revenue.toFixed(4)}</div>
              <div className="text-right font-mono text-emerald-600">
                ${loc.charged.toFixed(4)}
              </div>
              <div className="text-right font-mono">
                {loc.pending > 0 ? (
                  <Badge variant="secondary" className="font-mono">
                    ${loc.pending.toFixed(4)}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">$0</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
