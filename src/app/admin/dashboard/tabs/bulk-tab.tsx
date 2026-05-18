"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface JobRow {
  id: string;
  label: string | null;
  status: string;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  location_id: string;
  priority?: number;
  created_at: string;
  estimated_completion_at?: string | null;
  completed_at?: string | null;
}
interface BulkData {
  active_jobs: JobRow[];
  recent_completed: JobRow[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runner_health: any;
}

export function BulkTab({ data, loading }: { data: BulkData | undefined; loading: boolean }) {
  if (loading && !data) return <Skeleton className="h-96" />;
  if (!data) return <div className="text-muted-foreground">Sem dados</div>;

  return (
    <div className="space-y-6">
      {/* Runner health */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">Runner Health</h3>
          {data.runner_health?.consecutive_errors > 0 ? (
            <Badge variant="destructive">
              {data.runner_health.consecutive_errors} erros consecutivos
            </Badge>
          ) : (
            <Badge className="bg-emerald-100 text-emerald-700">OK</Badge>
          )}
        </div>
        <div className="grid grid-cols-4 gap-4 text-sm">
          <Stat label="Last tick" value={fmtRelative(data.runner_health?.last_tick_at)} />
          <Stat label="Fired" value={data.runner_health?.last_fired ?? 0} />
          <Stat label="Failed" value={data.runner_health?.last_failed ?? 0} />
          <Stat label="Skipped" value={data.runner_health?.last_skipped ?? 0} />
        </div>
      </Card>

      {/* Active jobs */}
      <Card className="p-4">
        <h3 className="font-semibold mb-3">Jobs ativos ({data.active_jobs.length})</h3>
        {data.active_jobs.length === 0 && (
          <div className="text-sm text-muted-foreground">Nenhum job ativo</div>
        )}
        <div className="space-y-2">
          {data.active_jobs.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </div>
      </Card>

      {/* Recent completed */}
      <Card className="p-4">
        <h3 className="font-semibold mb-3">
          Concluídos / cancelados (7d) — {data.recent_completed.length}
        </h3>
        <div className="space-y-1 text-xs">
          {data.recent_completed.map((j) => (
            <div key={j.id} className="flex items-center justify-between py-1 border-b last:border-0">
              <div>
                <span className="font-mono">{j.id.slice(0, 8)}</span>
                {j.label && <span className="ml-2 text-muted-foreground">{j.label}</span>}
              </div>
              <div className="flex gap-2 items-center">
                <Badge
                  variant={j.status === "completed" ? "default" : "secondary"}
                  className={j.status === "completed" ? "bg-emerald-100 text-emerald-700" : ""}
                >
                  {j.status}
                </Badge>
                <span className="font-mono">
                  {j.sent_count}/{j.total_contacts}
                </span>
              </div>
            </div>
          ))}
          {data.recent_completed.length === 0 && (
            <div className="text-muted-foreground">Sem jobs concluídos nos últimos 7d</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function JobCard({ job }: { job: JobRow }) {
  const pct =
    job.total_contacts > 0 ? Math.round((job.sent_count / job.total_contacts) * 100) : 0;
  const isPriority = (job.priority ?? 50) >= 70;
  const isBackground = (job.priority ?? 50) <= 30;
  return (
    <div className="p-3 border rounded">
      <div className="flex items-center justify-between mb-1">
        <div>
          <span className="font-mono text-xs text-muted-foreground">{job.id.slice(0, 8)}</span>
          {job.label && <span className="ml-2 font-medium">{job.label}</span>}
          {isPriority && <Badge className="ml-2 bg-red-100 text-red-700 text-[10px]">🔥 urgente</Badge>}
          {isBackground && (
            <Badge variant="secondary" className="ml-2 text-[10px]">
              🐌 background
            </Badge>
          )}
        </div>
        <Badge variant={job.status === "running" ? "default" : "secondary"}>{job.status}</Badge>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <div className="flex-1 bg-muted h-2 rounded overflow-hidden">
          <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-mono">
          {job.sent_count}/{job.total_contacts} ({pct}%)
        </span>
      </div>
      {job.estimated_completion_at && (
        <div className="text-xs text-muted-foreground mt-1">
          ETA: {new Date(job.estimated_completion_at).toLocaleString("pt-BR")}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase">{label}</div>
      <div className="font-mono text-base">{value}</div>
    </div>
  );
}

function fmtRelative(iso?: string): string {
  if (!iso) return "n/d";
  const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}min ago`;
  return `${Math.floor(ageSec / 3600)}h ago`;
}
