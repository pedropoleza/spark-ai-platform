"use client";

import { useEffect, useState, useCallback } from "react";
import { MessageSquare, Zap, CalendarCheck, Target, Clock, CheckCircle2, XCircle, AlertTriangle, Send, Tag, Database, RefreshCw } from "lucide-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface Metrics {
  messages_sent: number;
  leads_qualified: number;
  appointments_booked: number;
  total_tokens: number;
  active_conversations: number;
}

interface Conversation {
  id: string;
  contact_id: string;
  status: string;
  collected_data: Record<string, string>;
  message_count: number;
  last_message_at: string;
  updated_at: string;
}

interface LogEntry {
  id: string;
  action_type: string;
  action_payload: Record<string, unknown>;
  success: boolean;
  error_message: string | null;
  contact_id: string;
  ai_model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

interface FollowUp {
  id: string;
  contact_id: string;
  attempt_number: number;
  scheduled_at: string;
  status: string;
  custom_message: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, "success" | "warning" | "destructive" | "secondary" | "default"> = {
  active: "default",
  qualified: "success",
  booked: "success",
  disqualified: "destructive",
  handed_off: "warning",
  stale: "secondary",
  pending: "warning",
  sent: "success",
  cancelled: "secondary",
  failed: "destructive",
};

const ACTION_ICONS: Record<string, typeof Send> = {
  send_message: Send,
  ai_processing: Zap,
  update_field: Database,
  add_tag: Tag,
  remove_tag: Tag,
  book_appointment: CalendarCheck,
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default function ActivityPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [metricsRes, convsRes, logsRes, fuRes] = await Promise.allSettled([
      fetch("/api/activity?tab=metrics").then((r) => r.json()),
      fetch("/api/activity?tab=conversations").then((r) => r.json()),
      fetch("/api/activity?tab=logs").then((r) => r.json()),
      fetch("/api/activity?tab=followups").then((r) => r.json()),
    ]);

    if (metricsRes.status === "fulfilled") setMetrics(metricsRes.value.metrics);
    if (convsRes.status === "fulfilled") setConversations(convsRes.value.conversations || []);
    if (logsRes.status === "fulfilled") setLogs(logsRes.value.logs || []);
    if (fuRes.status === "fulfilled") setFollowups(fuRes.value.followups || []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <PageWrapper
      title="Atividade"
      subtitle="Acompanhe o desempenho dos seus agentes"
      actions={
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="w-3.5 h-3.5 mr-2" />
          Atualizar
        </Button>
      }
    >
      {/* Metricas */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <MetricCard icon={MessageSquare} label="Mensagens enviadas" value={metrics?.messages_sent || 0} sub="ultimos 30 dias" />
            <MetricCard icon={Target} label="Leads qualificados" value={metrics?.leads_qualified || 0} />
            <MetricCard icon={CalendarCheck} label="Agendamentos" value={metrics?.appointments_booked || 0} />
            <MetricCard icon={MessageSquare} label="Conversas ativas" value={metrics?.active_conversations || 0} />
            <MetricCard icon={Zap} label="Tokens usados" value={formatNumber(metrics?.total_tokens || 0)} sub="ultimos 30 dias" />
          </>
        )}
      </div>

      <Tabs defaultValue="conversations">
        <TabsList>
          <TabsTrigger value="conversations">Conversas ({conversations.length})</TabsTrigger>
          <TabsTrigger value="logs">Log de acoes ({logs.length})</TabsTrigger>
          <TabsTrigger value="followups">Follow-ups ({followups.length})</TabsTrigger>
        </TabsList>

        {/* Conversas */}
        <TabsContent value="conversations">
          {conversations.length === 0 ? (
            <EmptyState text="Nenhuma conversa registrada ainda" />
          ) : (
            <div className="space-y-2">
              {conversations.map((conv) => (
                <div key={conv.id} className="flex items-center gap-4 p-4 bg-white border border-neutral-200 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-neutral-900 truncate">
                        {conv.contact_id}
                      </span>
                      <Badge variant={STATUS_COLORS[conv.status] || "secondary"} className="text-[10px]">
                        {conv.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-neutral-400">
                      <span>{conv.message_count} msgs</span>
                      <span>{Object.keys(conv.collected_data || {}).length} dados coletados</span>
                      {conv.last_message_at && <span>{timeAgo(conv.last_message_at)}</span>}
                    </div>
                  </div>
                  {Object.keys(conv.collected_data || {}).length > 0 && (
                    <div className="hidden md:flex gap-1 flex-wrap max-w-xs">
                      {Object.entries(conv.collected_data).slice(0, 3).map(([k, v]) => (
                        <span key={k} className="text-[10px] bg-neutral-100 text-neutral-600 px-1.5 py-0.5 rounded">
                          {k}: {String(v).substring(0, 20)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Logs */}
        <TabsContent value="logs">
          {logs.length === 0 ? (
            <EmptyState text="Nenhuma acao registrada ainda" />
          ) : (
            <div className="space-y-1">
              {logs.map((log) => {
                const Icon = ACTION_ICONS[log.action_type] || Zap;
                return (
                  <div key={log.id} className="flex items-center gap-3 p-3 hover:bg-neutral-50 rounded-lg transition-colors">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${log.success ? "bg-neutral-100" : "bg-red-50"}`}>
                      {log.success ? (
                        <Icon className="w-3.5 h-3.5 text-neutral-600" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-neutral-900">{formatActionType(log.action_type)}</span>
                        {log.error_message && (
                          <span className="text-xs text-red-500 truncate max-w-xs">{log.error_message}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-neutral-400">
                        <span>{log.contact_id?.substring(0, 12)}...</span>
                        {log.duration_ms && <span>{log.duration_ms}ms</span>}
                        {log.prompt_tokens && <span>{(log.prompt_tokens || 0) + (log.completion_tokens || 0)} tokens</span>}
                      </div>
                    </div>
                    <span className="text-xs text-neutral-400 flex-shrink-0">
                      {timeAgo(log.created_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Follow-ups */}
        <TabsContent value="followups">
          {followups.length === 0 ? (
            <EmptyState text="Nenhum follow-up agendado" />
          ) : (
            <div className="space-y-2">
              {followups.map((fu) => (
                <div key={fu.id} className="flex items-center gap-4 p-3 bg-white border border-neutral-200 rounded-lg">
                  <div className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center flex-shrink-0">
                    {fu.status === "sent" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                    ) : fu.status === "pending" ? (
                      <Clock className="w-3.5 h-3.5 text-amber-500" />
                    ) : fu.status === "failed" ? (
                      <XCircle className="w-3.5 h-3.5 text-red-500" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-neutral-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm text-neutral-900">
                        Follow-up #{fu.attempt_number}
                      </span>
                      <Badge variant={STATUS_COLORS[fu.status] || "secondary"} className="text-[10px]">
                        {fu.status}
                      </Badge>
                    </div>
                    <span className="text-xs text-neutral-400">{fu.contact_id?.substring(0, 16)}...</span>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className="text-xs text-neutral-500 block">
                      {new Date(fu.scheduled_at).toLocaleDateString("pt-BR")}
                    </span>
                    <span className="text-[10px] text-neutral-400">
                      {new Date(fu.scheduled_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </PageWrapper>
  );
}

function MetricCard({ icon: Icon, label, value, sub }: { icon: typeof MessageSquare; label: string; value: number | string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="w-4 h-4 text-neutral-400" />
          <span className="text-xs text-neutral-500">{label}</span>
        </div>
        <span className="text-2xl font-semibold text-neutral-900">{value}</span>
        {sub && <p className="text-[10px] text-neutral-400 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-sm text-neutral-400">{text}</p>
    </div>
  );
}

function formatActionType(type: string): string {
  const map: Record<string, string> = {
    send_message: "Mensagem enviada",
    ai_processing: "Processamento IA",
    update_field: "Campo atualizado",
    add_tag: "Tag adicionada",
    remove_tag: "Tag removida",
    book_appointment: "Agendamento criado",
    move_pipeline: "Pipeline movido",
  };
  return map[type] || type;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
