"use client";

import { useEffect, useState, useCallback } from "react";
import { DollarSign, Zap, MessageSquare, Key, RefreshCw, TrendingUp } from "lucide-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

interface BillingSummary {
  total_interactions: number;
  total_tokens: number;
  total_cost_usd: number;
  total_markup_usd: number;
  total_charged_usd: number;
  using_custom_key: number;
  using_platform_key: number;
  pending_charges: number;
}

interface DailyUsage {
  date: string;
  tokens: number;
  cost: number;
  interactions: number;
}

interface ModelUsage {
  model: string;
  tokens: number;
  cost: number;
  count: number;
}

interface RecentRecord {
  id: string;
  action_type: string;
  model: string;
  tokens: number;
  cost: number;
  custom_key: boolean;
  charged: boolean;
  created_at: string;
}

export default function BillingPage() {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [period, setPeriod] = useState("30d");
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/billing?period=${period}`);
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary);
        setDaily(data.daily || []);
        setModels(data.models || []);
        setRecent(data.recent || []);
      }
    } catch (e) {
      console.error("Erro ao buscar billing:", e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const formatUsd = (n: number) => `$${n.toFixed(4)}`;
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <PageWrapper
      title="Billing"
      subtitle="Acompanhe o uso e custos da IA"
      actions={
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Ultimos 7 dias</SelectItem>
              <SelectItem value="30d">Ultimos 30 dias</SelectItem>
              <SelectItem value="all">Todo periodo</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchData}>
            <RefreshCw className="w-3.5 h-3.5 mr-2" />
            Atualizar
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : summary ? (
        <div className="space-y-6">
          {/* Metricas principais */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              icon={DollarSign}
              label="Total cobrado"
              value={formatUsd(summary.total_charged_usd)}
              sub={`Custo: ${formatUsd(summary.total_cost_usd)} + Markup: ${formatUsd(summary.total_markup_usd)}`}
            />
            <MetricCard
              icon={Zap}
              label="Tokens usados"
              value={formatTokens(summary.total_tokens)}
            />
            <MetricCard
              icon={MessageSquare}
              label="Interacoes"
              value={String(summary.total_interactions)}
              sub={`${summary.using_platform_key} cobradas | ${summary.using_custom_key} chave propria`}
            />
            <MetricCard
              icon={Key}
              label="Cobranças pendentes"
              value={String(summary.pending_charges)}
              sub={summary.pending_charges > 0 ? "Serao cobradas no proximo ciclo" : "Tudo em dia"}
            />
          </div>

          {/* Info sobre chave propria */}
          {summary.using_custom_key > 0 && (
            <div className="flex items-center gap-2 text-sm text-emerald-300 bg-emerald-500/10 px-4 py-3 rounded-lg">
              <Key className="w-4 h-4" />
              <span>
                {summary.using_custom_key} interacoes usaram chave OpenAI propria (sem cobranca de markup)
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Uso por modelo */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Uso por modelo</CardTitle>
              </CardHeader>
              <CardContent>
                {models.length === 0 ? (
                  <p className="text-sm text-neutral-400">Nenhum uso registrado</p>
                ) : (
                  <div className="space-y-3">
                    {models.map((m) => (
                      <div key={m.model} className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium text-neutral-100">{m.model}</span>
                          <span className="text-xs text-neutral-400 ml-2">{m.count} chamadas</span>
                        </div>
                        <div className="text-right">
                          <span className="text-sm font-medium text-neutral-100">{formatUsd(m.cost)}</span>
                          <span className="text-xs text-neutral-400 ml-2">{formatTokens(m.tokens)} tokens</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Uso diario */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  Uso diario
                </CardTitle>
              </CardHeader>
              <CardContent>
                {daily.length === 0 ? (
                  <p className="text-sm text-neutral-400">Nenhum uso registrado</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {daily.slice(-14).map((d) => (
                      <div key={d.date} className="flex items-center justify-between text-sm">
                        <span className="text-neutral-500 w-24">{d.date}</span>
                        <span className="text-neutral-400">{d.interactions} msgs</span>
                        <span className="text-neutral-400">{formatTokens(d.tokens)}</span>
                        <span className="font-medium text-neutral-100">{formatUsd(d.cost)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Registros recentes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Registros recentes</CardTitle>
              <CardDescription>Ultimas interacoes e custos</CardDescription>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="text-sm text-neutral-400">Nenhum registro</p>
              ) : (
                <div className="space-y-1">
                  {recent.map((r) => (
                    <div key={r.id} className="flex items-center justify-between py-2 text-sm border-b border-white/5 last:border-0">
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-200">{formatAction(r.action_type)}</span>
                        <Badge variant="secondary" className="text-[10px]">{r.model}</Badge>
                        {r.custom_key && <Badge variant="outline" className="text-[10px]">Chave propria</Badge>}
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-neutral-400">{formatTokens(r.tokens)} tokens</span>
                        <span className={r.custom_key ? "text-emerald-400" : "font-medium text-neutral-100"}>
                          {r.custom_key ? "Gratis" : formatUsd(r.cost)}
                        </span>
                        {!r.custom_key && (
                          <Badge variant={r.charged ? "success" : "warning"} className="text-[10px]">
                            {r.charged ? "Cobrado" : "Pendente"}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <p className="text-sm text-neutral-400">Erro ao carregar dados de billing</p>
      )}
    </PageWrapper>
  );
}

function MetricCard({ icon: Icon, label, value, sub }: { icon: typeof DollarSign; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="w-4 h-4 text-neutral-400" />
          <span className="text-xs text-neutral-500">{label}</span>
        </div>
        <span className="text-2xl font-semibold text-neutral-100">{value}</span>
        {sub && <p className="text-[10px] text-neutral-400 mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function formatAction(type: string): string {
  const map: Record<string, string> = {
    ai_processing: "Processamento IA",
    follow_up: "Follow-up",
    send_message: "Mensagem",
  };
  return map[type] || type;
}
