"use client";

import { useEffect, useState, useCallback } from "react";
import { MessageSquare, Zap, CalendarCheck, Target, Clock, CheckCircle2, XCircle, AlertTriangle, Send, Tag, Database, RefreshCw, ChevronDown, User, Bot } from "lucide-react";
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
  send_error_message: AlertTriangle,
  ai_processing: Zap,
  update_field: Database,
  add_tag: Tag,
  remove_tag: Tag,
  book_appointment: CalendarCheck,
  reschedule_appointment: CalendarCheck,
  critical_error: XCircle,
  reaction_send_text: Send,
  reaction_send_media: Send,
};

const ACTION_LABELS: Record<string, string> = {
  send_message: "Mensagem enviada",
  send_error_message: "Mensagem de erro",
  ai_processing: "Processamento IA",
  update_field: "Campo atualizado",
  add_tag: "Tag adicionada",
  remove_tag: "Tag removida",
  book_appointment: "Agendamento criado",
  reschedule_appointment: "Reagendamento",
  move_pipeline: "Pipeline movido",
  sync_standard_fields: "Sincronização GHL",
  sync_custom_fields: "Custom fields sincronizados",
  critical_error: "Erro crítico",
  reaction_send_text: "Reação: texto enviado",
  reaction_send_media: "Reação: mídia enviada",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `há ${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function extractMessagePreview(payload: Record<string, unknown>): string | null {
  const msg = payload.message;
  if (Array.isArray(msg)) return msg.filter(m => typeof m === "string").join(" | ").substring(0, 120);
  if (typeof msg === "string") return msg.substring(0, 120);
  return null;
}

function extractFieldInfo(payload: Record<string, unknown>): string | null {
  if (payload.field_key && payload.value) return `${payload.field_key} = "${String(payload.value).substring(0, 50)}"`;
  if (payload.tag) return `tag: ${payload.tag}`;
  if (payload.start_time) return `horário: ${payload.start_time}`;
  return null;
}

export default function ActivityPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [expandedConv, setExpandedConv] = useState<string | null>(null);

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
      subtitle="Acompanhe o desempenho dos seus agentes em tempo real."
      actions={
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="w-3.5 h-3.5 mr-2" />
          Atualizar
        </Button>
      }
    >
      {/* Métricas */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <MetricCard icon={MessageSquare} label="Mensagens enviadas" value={metrics?.messages_sent || 0} sub="últimos 30 dias" />
            <MetricCard icon={Target} label="Leads qualificados" value={metrics?.leads_qualified || 0} />
            <MetricCard icon={CalendarCheck} label="Agendamentos" value={metrics?.appointments_booked || 0} />
            <MetricCard icon={MessageSquare} label="Conversas ativas" value={metrics?.active_conversations || 0} />
            <MetricCard icon={Zap} label="Tokens usados" value={formatNumber(metrics?.total_tokens || 0)} sub="últimos 30 dias" />
          </>
        )}
      </div>

      <Tabs defaultValue="logs">
        <TabsList>
          <TabsTrigger value="logs">Log de ações ({logs.length})</TabsTrigger>
          <TabsTrigger value="conversations">Conversas ({conversations.length})</TabsTrigger>
          <TabsTrigger value="followups">Follow-ups ({followups.length})</TabsTrigger>
        </TabsList>

        {/* Logs - redesenhado com expansão */}
        <TabsContent value="logs">
          {logs.length === 0 ? (
            <EmptyState text="Nenhuma ação registrada ainda." />
          ) : (
            <div className="space-y-1.5">
              {logs.map((log) => {
                const Icon = ACTION_ICONS[log.action_type] || Zap;
                const isExpanded = expandedLog === log.id;
                const messagePreview = extractMessagePreview(log.action_payload);
                const fieldInfo = extractFieldInfo(log.action_payload);
                const totalTokens = (log.prompt_tokens || 0) + (log.completion_tokens || 0);

                return (
                  <div key={log.id} className={`rounded-xl border transition-all ${log.success ? "border-gray-200 bg-white" : "border-red-200 bg-red-50/30"} ${isExpanded ? "shadow-sm" : "hover:bg-gray-50"}`}>
                    <button
                      type="button"
                      onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                      className="w-full flex items-center gap-3 p-3 text-left"
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${log.success ? "bg-gray-100" : "bg-red-100"}`}>
                        {log.success ? <Icon className="w-4 h-4 text-gray-700" /> : <XCircle className="w-4 h-4 text-red-500" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">
                            {ACTION_LABELS[log.action_type] || log.action_type}
                          </span>
                          {!log.success && log.error_message && (
                            <span className="text-xs text-red-500 truncate max-w-[200px]">{log.error_message}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-500 font-mono">{log.contact_id?.substring(0, 16)}</span>
                          {messagePreview && (
                            <span className="text-xs text-gray-400 truncate max-w-[300px]">&ldquo;{messagePreview}&rdquo;</span>
                          )}
                          {fieldInfo && (
                            <span className="text-xs text-brand-600 font-mono">{fieldInfo}</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 flex-shrink-0">
                        {log.duration_ms && (
                          <span className="text-[10px] text-gray-400">{(log.duration_ms / 1000).toFixed(1)}s</span>
                        )}
                        {totalTokens > 0 && (
                          <span className="text-[10px] text-gray-400">{totalTokens.toLocaleString()} tok</span>
                        )}
                        <span className="text-xs text-gray-400">{timeAgo(log.created_at)}</span>
                        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3 pt-0 border-t border-gray-100 mx-3 mb-1">
                        <div className="grid grid-cols-2 gap-4 mt-3">
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Detalhes</p>
                            <div className="space-y-1.5 text-xs text-gray-700">
                              <div className="flex justify-between">
                                <span className="text-gray-500">Contato ID:</span>
                                <span className="font-mono">{log.contact_id}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-500">Tipo:</span>
                                <span>{log.action_type}</span>
                              </div>
                              {log.ai_model_used && (
                                <div className="flex justify-between">
                                  <span className="text-gray-500">Modelo:</span>
                                  <span className="font-mono">{log.ai_model_used}</span>
                                </div>
                              )}
                              {log.duration_ms && (
                                <div className="flex justify-between">
                                  <span className="text-gray-500">Duração:</span>
                                  <span>{log.duration_ms}ms</span>
                                </div>
                              )}
                              {log.prompt_tokens && (
                                <div className="flex justify-between">
                                  <span className="text-gray-500">Tokens (in/out):</span>
                                  <span>{log.prompt_tokens?.toLocaleString()} / {log.completion_tokens?.toLocaleString()}</span>
                                </div>
                              )}
                              <div className="flex justify-between">
                                <span className="text-gray-500">Horário:</span>
                                <span>{new Date(log.created_at).toLocaleString("pt-BR")}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-500">Status:</span>
                                <Badge variant={log.success ? "success" : "destructive"} className="text-[9px]">
                                  {log.success ? "Sucesso" : "Falha"}
                                </Badge>
                              </div>
                            </div>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Payload</p>
                            {messagePreview && (
                              <div className="mb-2">
                                <p className="text-[10px] text-gray-500 mb-0.5">Mensagem:</p>
                                <p className="text-xs text-gray-800 bg-gray-50 rounded-lg p-2 leading-relaxed">
                                  {Array.isArray(log.action_payload.message)
                                    ? (log.action_payload.message as string[]).map((m, i) => <span key={i} className="block">{String(m)}</span>)
                                    : String(log.action_payload.message)}
                                </p>
                              </div>
                            )}
                            {log.error_message && (
                              <div className="mb-2">
                                <p className="text-[10px] text-red-500 mb-0.5">Erro:</p>
                                <p className="text-xs text-red-700 bg-red-50 rounded-lg p-2">{log.error_message}</p>
                              </div>
                            )}
                            {!messagePreview && !log.error_message && (
                              <pre className="text-[10px] text-gray-600 bg-gray-50 rounded-lg p-2 overflow-x-auto max-h-[120px] font-mono">
                                {JSON.stringify(log.action_payload, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Conversas - redesenhado com expansão */}
        <TabsContent value="conversations">
          {conversations.length === 0 ? (
            <EmptyState text="Nenhuma conversa registrada ainda." />
          ) : (
            <div className="space-y-2">
              {conversations.map((conv) => {
                const isExpanded = expandedConv === conv.id;
                const dataEntries = Object.entries(conv.collected_data || {});

                return (
                  <div key={conv.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedConv(isExpanded ? null : conv.id)}
                      className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <User className="w-4 h-4 text-gray-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-gray-900">
                            {dataEntries.find(([k]) => k === "full_name")?.[1] || conv.contact_id.substring(0, 16)}
                          </span>
                          <Badge variant={STATUS_COLORS[conv.status] || "secondary"} className="text-[10px]">
                            {conv.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500">
                          <span>{conv.message_count} mensagens</span>
                          <span>{dataEntries.length} dados coletados</span>
                          {conv.last_message_at && <span>{timeAgo(conv.last_message_at)}</span>}
                        </div>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                    </button>

                    {isExpanded && dataEntries.length > 0 && (
                      <div className="px-4 pb-4 border-t border-gray-100">
                        <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mt-3 mb-2">Dados coletados</p>
                        <div className="grid grid-cols-2 gap-2">
                          {dataEntries.map(([k, v]) => (
                            <div key={k} className="bg-gray-50 rounded-lg px-3 py-2">
                              <span className="text-[10px] text-gray-400 block">{k}</span>
                              <span className="text-sm text-gray-900">{String(v)}</span>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-gray-400 mt-3 font-mono">ID: {conv.contact_id}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Follow-ups */}
        <TabsContent value="followups">
          {followups.length === 0 ? (
            <EmptyState text="Nenhum follow-up agendado." />
          ) : (
            <div className="space-y-2">
              {followups.map((fu) => (
                <div key={fu.id} className="flex items-center gap-4 p-3.5 bg-white border border-gray-200 rounded-xl">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    fu.status === "sent" ? "bg-emerald-100" :
                    fu.status === "pending" ? "bg-amber-100" :
                    fu.status === "failed" ? "bg-red-100" : "bg-gray-100"
                  }`}>
                    {fu.status === "sent" ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> :
                     fu.status === "pending" ? <Clock className="w-4 h-4 text-amber-600" /> :
                     fu.status === "failed" ? <XCircle className="w-4 h-4 text-red-500" /> :
                     <AlertTriangle className="w-4 h-4 text-gray-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-gray-900">
                        Follow-up #{fu.attempt_number}
                      </span>
                      <Badge variant={STATUS_COLORS[fu.status] || "secondary"} className="text-[10px]">
                        {fu.status}
                      </Badge>
                    </div>
                    <span className="text-xs text-gray-500 font-mono">{fu.contact_id?.substring(0, 20)}</span>
                    {fu.custom_message && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">&ldquo;{fu.custom_message}&rdquo;</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className="text-xs text-gray-600 block">
                      {new Date(fu.scheduled_at).toLocaleDateString("pt-BR")}
                    </span>
                    <span className="text-[10px] text-gray-400">
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
          <div className="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center">
            <Icon className="w-4 h-4 text-brand-600" />
          </div>
        </div>
        <span className="text-2xl font-bold text-gray-900">{value}</span>
        <p className="text-xs text-gray-500 mt-0.5">{label}</p>
        {sub && <p className="text-[10px] text-gray-400">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-2">
      <Bot className="w-8 h-8 text-gray-300" />
      <p className="text-sm text-gray-400">{text}</p>
    </div>
  );
}
