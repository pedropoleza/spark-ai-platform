"use client";

import { useEffect, useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  Bug,
  Lightbulb,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Plus,
  RefreshCw,
} from "lucide-react";

interface Signal {
  id: string;
  type: "failure" | "missed_capability" | "error" | "idea";
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  status: "open" | "triaged" | "in_progress" | "done" | "wontfix";
  source: "bot_auto" | "manual" | "system";
  metadata: Record<string, unknown>;
  admin_notes: string | null;
}

interface ApiResponse {
  ok: boolean;
  signals: Signal[];
  counts: { byStatus: Record<string, number>; byType: Record<string, number> };
}

const TYPE_META = {
  failure: { label: "Falha", icon: AlertTriangle, color: "text-red-600 bg-red-50 border-red-200" },
  missed_capability: { label: "Capacidade ausente", icon: HelpCircle, color: "text-amber-600 bg-amber-50 border-amber-200" },
  error: { label: "Erro técnico", icon: Bug, color: "text-orange-600 bg-orange-50 border-orange-200" },
  idea: { label: "Ideia", icon: Lightbulb, color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
} as const;

const SEVERITY_COLOR = {
  low: "bg-gray-100 text-gray-700",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
} as const;

const STATUS_LABEL = {
  open: "Aberto",
  triaged: "Triado",
  in_progress: "Em andamento",
  done: "Concluído",
  wontfix: "Não fazer",
} as const;

export function SignalsClient() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [counts, setCounts] = useState<ApiResponse["counts"]>({ byStatus: {}, byType: {} });
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("open");
  const [filterType, setFilterType] = useState("all");
  const [filterPeriod, setFilterPeriod] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL("/api/admin/signals", window.location.origin);
      url.searchParams.set("status", filterStatus);
      url.searchParams.set("type", filterType);
      url.searchParams.set("period", filterPeriod);
      url.searchParams.set("limit", "200");
      const res = await fetch(url.toString());
      const data: ApiResponse = await res.json();
      if (data.ok) {
        setSignals(data.signals);
        setCounts(data.counts);
      }
    } catch (err) {
      console.error("fetch signals failed", err);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterType, filterPeriod]);

  useEffect(() => {
    fetchSignals();
  }, [fetchSignals]);

  const updateSignal = async (id: string, patch: Partial<Signal>) => {
    const res = await fetch(`/api/admin/signals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (data.ok) {
      setSignals((s) => s.map((sig) => (sig.id === id ? data.signal : sig)));
    }
  };

  const deleteSignal = async (id: string) => {
    if (!confirm("Deletar definitivo? (use 'wontfix' pra arquivar mantendo histórico)")) return;
    const res = await fetch(`/api/admin/signals/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      setSignals((s) => s.filter((sig) => sig.id !== id));
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">SparkBot · Painel Admin</h1>
            <p className="text-sm text-gray-500 mt-1">
              Falhas, capacidades ausentes, erros e ideias — agrupadas por similaridade.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => fetchSignals()} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Atualizar
            </Button>
            <Button size="sm" onClick={() => setShowAddForm(!showAddForm)}>
              <Plus className="w-4 h-4 mr-2" />
              Adicionar
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(["failure", "missed_capability", "error", "idea"] as const).map((t) => {
            const meta = TYPE_META[t];
            const Icon = meta.icon;
            return (
              <Card key={t} className={`p-4 border-2 ${meta.color}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium opacity-75">{meta.label}</p>
                    <p className="text-2xl font-bold mt-1">{counts.byType[t] || 0}</p>
                  </div>
                  <Icon className="w-6 h-6 opacity-50" />
                </div>
              </Card>
            );
          })}
        </div>

        {/* Add form */}
        {showAddForm && <AddSignalForm onAdded={() => { fetchSignals(); setShowAddForm(false); }} />}

        {/* Filters */}
        <Card className="p-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[180px]">
              <Label className="text-xs">Status</Label>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="open">Aberto ({counts.byStatus.open || 0})</SelectItem>
                  <SelectItem value="triaged">Triado ({counts.byStatus.triaged || 0})</SelectItem>
                  <SelectItem value="in_progress">Em andamento ({counts.byStatus.in_progress || 0})</SelectItem>
                  <SelectItem value="done">Concluído ({counts.byStatus.done || 0})</SelectItem>
                  <SelectItem value="wontfix">Não fazer ({counts.byStatus.wontfix || 0})</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <Label className="text-xs">Tipo</Label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="failure">Falhas</SelectItem>
                  <SelectItem value="missed_capability">Capacidades ausentes</SelectItem>
                  <SelectItem value="error">Erros</SelectItem>
                  <SelectItem value="idea">Ideias</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <Label className="text-xs">Período</Label>
              <Select value={filterPeriod} onValueChange={setFilterPeriod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tudo</SelectItem>
                  <SelectItem value="7d">Últimos 7 dias</SelectItem>
                  <SelectItem value="30d">Últimos 30 dias</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>

        {/* List */}
        <div className="space-y-3">
          {loading && signals.length === 0 && (
            <Card className="p-8 text-center text-gray-500">Carregando…</Card>
          )}
          {!loading && signals.length === 0 && (
            <Card className="p-8 text-center text-gray-500">
              Nenhum signal pros filtros atuais.
            </Card>
          )}
          {signals.map((sig) => {
            const meta = TYPE_META[sig.type];
            const Icon = meta.icon;
            const isExpanded = expandedId === sig.id;
            return (
              <Card key={sig.id} className="overflow-hidden">
                <div
                  className="p-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => setExpandedId(isExpanded ? null : sig.id)}
                >
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${meta.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <h3 className="font-semibold text-gray-900 break-words">{sig.title}</h3>
                        <div className="flex gap-2 items-center flex-shrink-0">
                          <Badge variant="outline" className="font-mono">
                            ×{sig.occurrence_count}
                          </Badge>
                          <Badge className={SEVERITY_COLOR[sig.severity]}>{sig.severity}</Badge>
                          <Badge variant="secondary">{STATUS_LABEL[sig.status]}</Badge>
                        </div>
                      </div>
                      {sig.description && (
                        <p className="text-sm text-gray-600 mt-1 line-clamp-2">{sig.description}</p>
                      )}
                      <div className="flex gap-3 text-xs text-gray-400 mt-2">
                        <span>{meta.label}</span>
                        <span>•</span>
                        <span>{sig.source}</span>
                        <span>•</span>
                        <span>último: {new Date(sig.last_seen_at).toLocaleString("pt-BR")}</span>
                      </div>
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t bg-gray-50 p-4 space-y-4">
                    <div className="grid md:grid-cols-3 gap-3">
                      <div>
                        <Label className="text-xs">Status</Label>
                        <Select value={sig.status} onValueChange={(v) => updateSignal(sig.id, { status: v as Signal["status"] })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="open">Aberto</SelectItem>
                            <SelectItem value="triaged">Triado</SelectItem>
                            <SelectItem value="in_progress">Em andamento</SelectItem>
                            <SelectItem value="done">Concluído</SelectItem>
                            <SelectItem value="wontfix">Não fazer</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">Severity</Label>
                        <Select value={sig.severity} onValueChange={(v) => updateSignal(sig.id, { severity: v as Signal["severity"] })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="critical">Critical</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => deleteSignal(sig.id)}
                        >
                          Deletar
                        </Button>
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs">Notas (admin)</Label>
                      <Textarea
                        defaultValue={sig.admin_notes || ""}
                        placeholder="Observações pra triage..."
                        className="text-sm"
                        onBlur={(e) => {
                          if (e.target.value !== (sig.admin_notes || "")) {
                            updateSignal(sig.id, { admin_notes: e.target.value });
                          }
                        }}
                      />
                    </div>

                    {sig.description && (
                      <div>
                        <Label className="text-xs">Descrição completa</Label>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap mt-1 p-3 bg-white rounded border">
                          {sig.description}
                        </p>
                      </div>
                    )}

                    <div>
                      <Label className="text-xs">Histórico</Label>
                      <div className="text-xs text-gray-600 mt-1">
                        Primeira ocorrência: {new Date(sig.first_seen_at).toLocaleString("pt-BR")} ·
                        Última: {new Date(sig.last_seen_at).toLocaleString("pt-BR")} ·
                        ID: <span className="font-mono">{sig.id}</span>
                      </div>
                    </div>

                    {sig.metadata && Object.keys(sig.metadata).length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
                          Metadata (raw)
                        </summary>
                        <pre className="mt-2 p-3 bg-white rounded border overflow-auto max-h-64 text-[11px]">
                          {JSON.stringify(sig.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AddSignalForm({ onAdded }: { onAdded: () => void }) {
  const [type, setType] = useState<Signal["type"]>("idea");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Signal["severity"]>("medium");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, title, description, severity }),
      });
      const data = await res.json();
      if (data.ok) {
        setTitle("");
        setDescription("");
        onAdded();
      } else {
        alert("Erro: " + data.error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="p-4 space-y-3 border-2 border-dashed">
      <div className="flex items-center gap-2">
        <Plus className="w-4 h-4 text-gray-500" />
        <h3 className="font-semibold text-gray-900">Adicionar signal</h3>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Tipo</Label>
          <Select value={type} onValueChange={(v) => setType(v as Signal["type"])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="idea">Ideia</SelectItem>
              <SelectItem value="failure">Falha</SelectItem>
              <SelectItem value="missed_capability">Capacidade ausente</SelectItem>
              <SelectItem value="error">Erro técnico</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Severity</Label>
          <Select value={severity} onValueChange={(v) => setSeverity(v as Signal["severity"])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label className="text-xs">Título (curto, sintético)</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ex: Implementar dashboard de conversão por carrier"
        />
      </div>
      <div>
        <Label className="text-xs">Descrição (opcional)</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Contexto, motivação, link pra discussão..."
          rows={3}
        />
      </div>
      <Button onClick={submit} disabled={submitting || !title.trim()} size="sm">
        {submitting ? "Salvando..." : "Salvar"}
      </Button>
    </Card>
  );
}
