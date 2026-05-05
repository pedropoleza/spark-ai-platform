"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Loader2, Zap, Clock, Pencil, Play, Trash2, Plus, AlertTriangle,
  Calendar, MessageSquare, Trophy, Snowflake, FileText, ListChecks, Bell,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface Rule {
  id: string;
  agent_id: string;
  rule_type: "reactive" | "scheduled";
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_config: Record<string, unknown>;
  prompt_instruction: string;
  tools_allowed: string[] | null;
  cooldown_minutes: number;
  ai_model: string | null;
  source: "system" | "custom";
}

const ICONS: Record<string, typeof Zap> = {
  "Briefing pré-reunião": Calendar,
  "Pós-reunião": MessageSquare,
  "No-show": AlertTriangle,
  "Opportunity parada": Clock,
  "Task vencendo": Bell,
  "Tarefa atrasada": AlertTriangle,
  "Mensagem inbound não respondida": MessageSquare,
  "Lead esfriando": Snowflake,
  "Deal fechado": Trophy,
  "Novo lead atribuído": Plus,
  "Resumo matinal": FileText,
  "Resumo fim do dia": FileText,
  "Reflexão semanal": ListChecks,
  "Pipeline review": ListChecks,
};

interface ProactiveRulesPanelProps {
  testSessionId: string | null;
  repPhone: string;
}

/**
 * Aba "Proatividade" — gerencia regras + simula.
 */
export function ProactiveRulesPanel({ testSessionId, repPhone }: ProactiveRulesPanelProps) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [simulatingRule, setSimulatingRule] = useState<Rule | null>(null);
  const [activeTab, setActiveTab] = useState<"reactive" | "scheduled">("reactive");

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch("/api/agents/sparkbot/rules");
      if (res.ok) {
        const data = await res.json();
        setRules(data.rules || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleToggle = async (rule: Rule, newEnabled: boolean) => {
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: newEnabled } : r)));
    try {
      const res = await fetch(`/api/agents/sparkbot/rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newEnabled }),
      });
      if (!res.ok) {
        toast.error("Falha ao atualizar regra");
        await fetchRules();
      }
    } catch {
      await fetchRules();
    }
  };

  const handleDelete = async (rule: Rule) => {
    if (rule.source === "system") {
      toast.error("Regras pré-configuradas não podem ser apagadas. Desabilite via toggle.");
      return;
    }
    if (!confirm(`Apagar regra "${rule.name}"? Não pode desfazer.`)) return;
    const res = await fetch(`/api/agents/sparkbot/rules/${rule.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Regra apagada");
      await fetchRules();
    } else {
      toast.error("Falha ao apagar");
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
      </div>
    );
  }

  const reactiveRules = rules.filter((r) => r.rule_type === "reactive");
  const scheduledRules = rules.filter((r) => r.rule_type === "scheduled");
  const visible = activeTab === "reactive" ? reactiveRules : scheduledRules;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-gray-200">
        <button
          onClick={() => setActiveTab("reactive")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "reactive" ? "border-brand-500 text-brand-600" : "border-transparent text-gray-500"
          }`}
        >
          ⚡ Reativos ({reactiveRules.length})
        </button>
        <button
          onClick={() => setActiveTab("scheduled")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "scheduled" ? "border-brand-500 text-brand-600" : "border-transparent text-gray-500"
          }`}
        >
          🕐 Agendadas ({scheduledRules.length})
        </button>
      </div>

      <div className="text-xs text-gray-500">
        {activeTab === "reactive"
          ? "Disparam por evento (reunião próxima, no-show, opp parada, msg não respondida, etc)."
          : "Disparam em horário fixo (resumo matinal, semanal, pipeline review)."}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {visible.map((rule) => {
          const Icon = ICONS[rule.name] || Zap;
          return (
            <Card key={rule.id} className={`${!rule.enabled ? "opacity-60" : ""}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className="w-4 h-4 text-brand-600 flex-shrink-0" />
                    <h3 className="font-semibold text-sm text-gray-900 truncate">{rule.name}</h3>
                  </div>
                  <Switch checked={rule.enabled} onCheckedChange={(v) => handleToggle(rule, v)} />
                </div>
                <p className="text-xs text-gray-500 mb-2 line-clamp-2 min-h-[2rem]">
                  {rule.description}
                </p>

                <div className="flex flex-wrap items-center gap-1 mb-3">
                  <Badge variant="secondary" className="text-[10px]">
                    {triggerSummary(rule)}
                  </Badge>
                  {rule.source === "custom" && (
                    <Badge variant="outline" className="text-[10px]">🔧 customizada</Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">
                    {rule.cooldown_minutes >= 60 ? `cooldown ${Math.round(rule.cooldown_minutes / 60)}h` : `cooldown ${rule.cooldown_minutes}m`}
                  </Badge>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm" variant="outline"
                    className="text-xs h-7 flex-1"
                    onClick={() => setSimulatingRule(rule)}
                    disabled={!testSessionId}
                    title={!testSessionId ? "Abra a aba Teste e mande pelo menos uma mensagem antes" : "Simular essa regra"}
                  >
                    <Play className="w-3 h-3 mr-1" />
                    Simular
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className="text-xs h-7"
                    onClick={() => setEditingRule(rule)}
                  >
                    <Pencil className="w-3 h-3" />
                  </Button>
                  {rule.source === "custom" && (
                    <Button
                      size="sm" variant="ghost"
                      className="text-xs h-7 text-red-500 hover:text-red-700"
                      onClick={() => handleDelete(rule)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!testSessionId && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          💡 Abra a aba <strong>Teste</strong> e mande pelo menos uma mensagem pra criar uma sessão.
          Aí o botão &ldquo;Simular&rdquo; vai funcionar (alerta aparece no chat).
        </p>
      )}

      <Card>
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-900">Disparar lembretes agora</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Roda o runner de reminders manualmente. Útil pra testar &ldquo;me lembra em
              X&rdquo; sem esperar o cron diário (que é a limitação do plano Hobby da Vercel).
            </p>
          </div>
          <RunRemindersButton />
        </CardContent>
      </Card>

      {/* Edit modal */}
      {editingRule && (
        <RuleEditModal
          rule={editingRule}
          onClose={() => setEditingRule(null)}
          onSaved={async () => {
            setEditingRule(null);
            await fetchRules();
          }}
        />
      )}

      {/* Simulate modal */}
      {simulatingRule && (
        <SimulateRuleModal
          rule={simulatingRule}
          sessionId={testSessionId!}
          repPhone={repPhone}
          onClose={() => setSimulatingRule(null)}
          onFired={() => setSimulatingRule(null)}
        />
      )}
    </div>
  );
}

function RunRemindersButton() {
  const [running, setRunning] = useState(false);
  const handleRun = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/agents/sparkbot/run-reminders", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Falhou");
        return;
      }
      toast.success(
        `Reminders: ${data.fired} disparados, ${data.failed} falhas, ${data.skipped} skipped (${data.duration_ms}ms)`,
      );
    } finally {
      setRunning(false);
    }
  };
  return (
    <Button onClick={handleRun} disabled={running} size="sm">
      {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
      Disparar agora
    </Button>
  );
}

function triggerSummary(rule: Rule): string {
  if (rule.rule_type === "scheduled") {
    const cron = (rule.trigger_config as { cron?: string }).cron;
    if (!cron) return "agendada";
    return formatCron(cron);
  }
  const cfg = rule.trigger_config as { event?: string; offset_minutes?: number; days_threshold?: number; hours_threshold?: number };
  switch (cfg.event) {
    case "appointment_upcoming": return `${Math.abs(cfg.offset_minutes || 0)}min antes do appointment`;
    case "post_meeting": return `${cfg.offset_minutes}min após reunião`;
    case "appointment_no_show": return "no-show detectado";
    case "opportunity_stale": return `opp parada >${cfg.days_threshold}d`;
    case "task_due_soon": return `${Math.abs(cfg.offset_minutes || 0)}min antes do due`;
    case "task_overdue": return `${cfg.offset_minutes}min após due`;
    case "inbound_unanswered": return `>${cfg.hours_threshold}h sem resposta`;
    case "deal_won": return "deal won";
    case "contact_assigned_to_rep": return "novo lead atribuído";
    case "contact_inactive": return `>${cfg.days_threshold}d sem msg`;
    default: return cfg.event || "—";
  }
}

function formatCron(cron: string): string {
  const map: Record<string, string> = {
    "0 8 * * 1-5": "08:00 seg-sex",
    "0 18 * * 1-5": "18:00 seg-sex",
    "0 17 * * 5": "sex 17:00",
    "0 9 * * 1": "seg 09:00",
  };
  return map[cron] || cron;
}

// =====================================================
// Edit Modal
// =====================================================
function RuleEditModal({
  rule, onClose, onSaved,
}: { rule: Rule; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(rule.name);
  const [description, setDescription] = useState(rule.description || "");
  const [promptInstruction, setPromptInstruction] = useState(rule.prompt_instruction);
  const [cooldownMinutes, setCooldownMinutes] = useState(rule.cooldown_minutes);
  const [aiModel, setAiModel] = useState(rule.ai_model || "claude-haiku-4-5-20251001");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/sparkbot/rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, description, prompt_instruction: promptInstruction,
          cooldown_minutes: cooldownMinutes, ai_model: aiModel,
        }),
      });
      if (res.ok) {
        toast.success("Regra atualizada");
        onSaved();
      } else {
        toast.error("Falha ao atualizar");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Editar regra</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <Label className="text-sm">Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
          <div>
            <Label className="text-sm">Descrição</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          <div>
            <Label className="text-sm">Instrução pra IA</Label>
            <p className="text-xs text-gray-500 mb-1.5">
              O que o Sparkbot deve dizer/fazer quando essa regra dispara. Escreva em linguagem natural.
              A IA recebe isso + contexto do trigger e decide a mensagem dinamicamente.
            </p>
            <Textarea
              value={promptInstruction}
              onChange={(e) => setPromptInstruction(e.target.value)}
              maxLength={3000}
              rows={8}
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-gray-400 mt-1">{promptInstruction.length} / 3000</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-sm">Cooldown (min)</Label>
              <Input
                type="number" min={0} max={10080}
                value={cooldownMinutes}
                onChange={(e) => setCooldownMinutes(parseInt(e.target.value) || 0)}
              />
              <p className="text-[10px] text-gray-400 mt-0.5">
                Tempo mín entre disparos da mesma regra/target. 0 = sem cooldown.
              </p>
            </div>
            <div>
              <Label className="text-sm">Modelo IA</Label>
              <select
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (rápido, barato)</option>
                <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (mais inteligente)</option>
                <option value="gpt-4.1">GPT-4.1</option>
                <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
              </select>
            </div>
          </div>
          {rule.source === "system" && (
            <div className="text-xs bg-gray-50 border border-gray-200 rounded p-3 text-gray-600">
              Esta é uma regra <strong>pré-configurada</strong>. Você pode editar conteúdo e
              comportamento, mas ela não pode ser apagada (só desabilitada via toggle).
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Salvar
          </Button>
        </div>
      </div>
    </div>
  );
}

// =====================================================
// Simulate Modal
// =====================================================
function SimulateRuleModal({
  rule, sessionId, repPhone, onClose, onFired,
}: {
  rule: Rule; sessionId: string; repPhone: string;
  onClose: () => void; onFired: () => void;
}) {
  const [mockContext, setMockContext] = useState(() => JSON.stringify(defaultMockContext(rule), null, 2));
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(mockContext);
    } catch {
      toast.error("Mock context não é JSON válido");
      return;
    }
    setRunning(true);
    try {
      const res = await fetch("/api/agents/account-assistant/test/simulate-rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          rule_id: rule.id,
          mock_context: parsed,
          ...(repPhone ? { rep_phone: repPhone } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Falhou");
        return;
      }
      toast.success(`Regra disparada (${data.duration_ms}ms)`);
      onFired();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Simular: {rule.name}</h2>
          <p className="text-xs text-gray-500 mt-1">
            Dispara a regra na sessão de teste atual com dados mock. Bypass cooldown e quiet hours.
          </p>
        </div>
        <div className="p-6 space-y-3">
          <Label className="text-sm">Contexto (mock data pra IA usar)</Label>
          <p className="text-xs text-gray-500">
            Edite o JSON conforme o cenário que quer testar. Ex: trocar appointment_id por um real
            do seu Spark Leads pra IA usar tools com dados reais.
          </p>
          <Textarea
            value={mockContext}
            onChange={(e) => setMockContext(e.target.value)}
            rows={10}
            className="font-mono text-xs"
          />
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleRun} disabled={running}>
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            Disparar
          </Button>
        </div>
      </div>
    </div>
  );
}

function defaultMockContext(rule: Rule): Record<string, unknown> {
  const cfg = rule.trigger_config as Record<string, unknown>;
  switch (cfg.event) {
    case "appointment_upcoming":
    case "post_meeting":
    case "appointment_no_show":
      return {
        appointment_id: "MOCK_APPT_ID",
        contact_id: "MOCK_CONTACT_ID",
        contact_name: "João Silva (mock)",
        start_time: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
    case "opportunity_stale":
      return { opportunity_id: "MOCK_OPP_ID", days_in_stage: 9, opp_name: "Mock Deal" };
    case "task_due_soon":
    case "task_overdue":
      return { task_id: "MOCK_TASK_ID", contact_id: "MOCK_CONTACT_ID", title: "Mock task" };
    case "inbound_unanswered":
      return { contact_id: "MOCK_CONTACT_ID", contact_name: "Maria (mock)", hours_unanswered: 5 };
    case "deal_won":
      return { opportunity_id: "MOCK_OPP_ID", opp_name: "Mock Deal", value: 5000 };
    case "contact_assigned_to_rep":
      return { contact_id: "MOCK_CONTACT_ID", contact_name: "Pedro (mock)" };
    case "contact_inactive":
      return { contact_id: "MOCK_CONTACT_ID", contact_name: "Ana (mock)", days_inactive: 8 };
    default:
      return { note: "scheduled rule — sem mock data necessário, IA vai chamar tools direto" };
  }
}
