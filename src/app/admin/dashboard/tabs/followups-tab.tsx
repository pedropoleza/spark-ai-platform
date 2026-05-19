"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface Sequence {
  id: string;
  rep_id?: string;
  contact_name: string | null;
  contact_phone?: string | null;
  goal: string | null;
  sequence_type: string;
  status: string;
  approval_status?: string;
  spam_risk: string | null;
  spam_score: number | null;
  total_messages: number;
  sent_messages: number;
  failed_messages?: number;
  skipped_messages?: number;
  created_at: string;
  cancelled_reason?: string | null;
  completed_at?: string | null;
}

interface FollowupsData {
  active_sequences: Sequence[];
  recent_completed: Sequence[];
  stats_30d: {
    total: number;
    by_status: Record<string, number>;
    by_risk: Record<string, number>;
    by_approval: Record<string, number>;
    by_type: Record<string, number>;
  };
  events_7d: Record<string, number>;
}

const RISK_COLOR: Record<string, string> = {
  low: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-red-100 text-red-700",
};

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  scheduled: "bg-blue-100 text-blue-700",
  running: "bg-emerald-100 text-emerald-700",
  paused: "bg-amber-100 text-amber-700",
  completed: "bg-purple-100 text-purple-700",
  cancelled: "bg-gray-100 text-gray-500",
  skipped_reply: "bg-cyan-100 text-cyan-700",
  failed: "bg-red-100 text-red-700",
};

export function FollowupsTab({
  data,
  loading,
}: {
  data: FollowupsData | undefined;
  loading: boolean;
}) {
  if (loading && !data) return <Skeleton className="h-96" />;
  if (!data) return <div className="text-muted-foreground">Sem dados</div>;

  return (
    <div className="space-y-6">
      {/* Funnel 30d */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Total 30d</div>
          <div className="text-2xl font-bold">{data.stats_30d.total}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Aprovados</div>
          <div className="text-2xl font-bold text-emerald-600">
            {(data.stats_30d.by_approval.approved ?? 0) + (data.stats_30d.by_approval.auto_approved ?? 0)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            auto: {data.stats_30d.by_approval.auto_approved ?? 0}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Contato respondeu</div>
          <div className="text-2xl font-bold text-cyan-600">
            {data.stats_30d.by_status.skipped_reply ?? 0}
          </div>
          <div className="text-xs text-muted-foreground mt-1">% sucesso real</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Bloqueados/Cancel</div>
          <div className="text-2xl font-bold text-amber-600">
            {(data.stats_30d.by_status.cancelled ?? 0) + (data.stats_30d.by_status.failed ?? 0)}
          </div>
        </Card>
      </div>

      {/* Risk breakdown */}
      <Card className="p-4">
        <h3 className="font-semibold mb-3">Spam Risk (últimos 30d)</h3>
        <div className="grid grid-cols-3 gap-4">
          {(["low", "medium", "high"] as const).map((r) => (
            <div key={r} className="flex flex-col items-center p-3 rounded border">
              <Badge className={RISK_COLOR[r]}>{r}</Badge>
              <div className="text-2xl font-bold mt-2">{data.stats_30d.by_risk[r] ?? 0}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Active sequences */}
      <Card className="p-4">
        <h3 className="font-semibold mb-3">Sequences ativas ({data.active_sequences.length})</h3>
        {data.active_sequences.length === 0 && (
          <div className="text-sm text-muted-foreground">Nenhuma sequence ativa.</div>
        )}
        <div className="space-y-2">
          {data.active_sequences.map((s) => (
            <SeqRow key={s.id} seq={s} />
          ))}
        </div>
      </Card>

      {/* Recent completed */}
      <Card className="p-4">
        <h3 className="font-semibold mb-3">
          Recentes (concluídas/canceladas — 7d) — {data.recent_completed.length}
        </h3>
        <div className="space-y-1 text-xs">
          {data.recent_completed.map((s) => (
            <div key={s.id} className="flex justify-between py-1 border-b last:border-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">{s.id.slice(0, 8)}</span>
                <span>{s.contact_name || "(sem nome)"}</span>
              </div>
              <div className="flex items-center gap-2">
                {s.spam_risk && <Badge className={RISK_COLOR[s.spam_risk]}>{s.spam_risk}</Badge>}
                <Badge className={STATUS_COLOR[s.status]}>{s.status}</Badge>
                <span className="font-mono">
                  {s.sent_messages}/{s.total_messages}
                </span>
              </div>
            </div>
          ))}
          {data.recent_completed.length === 0 && (
            <div className="text-muted-foreground">Sem sequences finalizadas 7d</div>
          )}
        </div>
      </Card>

      {/* Events */}
      <Card className="p-4">
        <h3 className="font-semibold mb-3">Eventos (7d)</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          {Object.entries(data.events_7d).map(([type, count]) => (
            <div key={type} className="flex justify-between items-center px-2 py-1 bg-muted rounded">
              <span className="font-mono">{type}</span>
              <Badge variant="secondary">{count}</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function SeqRow({ seq }: { seq: Sequence }) {
  const pct = seq.total_messages > 0 ? Math.round((seq.sent_messages / seq.total_messages) * 100) : 0;
  return (
    <div className="p-3 border rounded">
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="font-mono text-xs text-muted-foreground">{seq.id.slice(0, 8)}</span>
          <span className="ml-2 font-medium">{seq.contact_name || "(sem nome)"}</span>
          {seq.contact_phone && (
            <span className="ml-1 text-xs text-muted-foreground">{seq.contact_phone}</span>
          )}
        </div>
        <div className="flex gap-2">
          {seq.spam_risk && <Badge className={RISK_COLOR[seq.spam_risk]}>{seq.spam_risk}</Badge>}
          <Badge className={STATUS_COLOR[seq.status]}>{seq.status}</Badge>
        </div>
      </div>
      {seq.goal && <div className="text-xs text-muted-foreground mb-2">🎯 {seq.goal}</div>}
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-muted h-2 rounded overflow-hidden">
          <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-mono">
          {seq.sent_messages}/{seq.total_messages} ({pct}%)
        </span>
        <span className="text-xs text-muted-foreground">{seq.sequence_type}</span>
      </div>
    </div>
  );
}
