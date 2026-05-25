"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronDown, ChevronUp, Play, Pause, Check, Plus, Trash2 } from "lucide-react";
import { AMark, StatusBadge, ChannelChip, PriceBadge } from "@/components/hub/primitives";
import { MODULE_LABEL, MODULE_SUBTITLE } from "@/components/hub/module-labels";
import { TestChat } from "./test-chat";
import type { HubAgentDetail } from "@/lib/hub/data";
import type { AgentStatus } from "@/components/hub/types";
import type { DataField, FollowUpConfig, WorkingHoursConfig } from "@/types/agent";

const TEMPLATE_LABEL: Record<string, string> = {
  sparkbot: "SparkBot",
  sales: "Vendas",
  recruitment: "Recrutamento",
  custom: "Personalizado",
};

type ConfMode = "always" | "medium_and_high" | "high_only";
type Tab = "config" | "messages" | "docs" | "history";

const num = (v: unknown, d: number) => (typeof v === "number" && !isNaN(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || `campo_${Date.now()}`;

function seedFollow(v: unknown): FollowUpConfig {
  const f = (v ?? {}) as Partial<FollowUpConfig>;
  return {
    enabled: !!f.enabled,
    mode: f.mode === "manual" ? "manual" : "ai_auto",
    intensity: num(f.intensity, 5),
    max_attempts: num(f.max_attempts, 3),
    min_delay_minutes: num(f.min_delay_minutes, 10),
    max_delay_minutes: num(f.max_delay_minutes, 10080),
    custom_prompt: str(f.custom_prompt),
    manual_steps: Array.isArray(f.manual_steps) ? f.manual_steps : [],
  };
}
function seedHours(v: unknown): WorkingHoursConfig {
  const w = (v ?? {}) as Partial<WorkingHoursConfig>;
  return {
    enabled: !!w.enabled,
    timezone: str(w.timezone) || "America/New_York",
    mode: w.mode === "only_outside" ? "only_outside" : "only_during",
    schedule: (w.schedule as WorkingHoursConfig["schedule"]) || {},
  };
}
type Quiet = { enabled: boolean; start: string; end: string; timezone?: string; days?: number[] };
function seedQuiet(v: unknown): Quiet {
  const q = (v ?? {}) as Partial<Quiet>;
  return { enabled: !!q.enabled, start: str(q.start) || "21:00", end: str(q.end) || "08:00", timezone: q.timezone, days: q.days };
}

interface Editable {
  tone_creativity: number;
  tone_formality: number;
  tone_naturalness: number;
  tone_aggressiveness: number;
  custom_instructions: string;
  confirmation_mode: ConfMode;
  data_fields: DataField[];
  follow_up_config: FollowUpConfig;
  working_hours: WorkingHoursConfig;
  knowledge_base_instructions: string;
  enabled_kbs: string[];
  max_messages_per_conversation: number;
  daily_proactive_limit: number;
  quiet_hours: Quiet;
}

export function AgentDetailView({ detail }: { detail: HubAgentDetail }) {
  const router = useRouter();
  const isSparkbot = detail.template_key === "sparkbot";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (detail.config ?? {}) as Record<string, any>;

  const [tab, setTab] = useState<Tab>("config");
  const [status, setStatus] = useState<AgentStatus>(detail.status);
  const [enabled, setEnabled] = useState<Set<string>>(
    new Set(detail.modules.filter((m) => m.enabled).map((m) => m.key)),
  );
  const [open, setOpen] = useState<Set<string>>(new Set(["behavior"]));
  const [saving, setSaving] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [showTest, setShowTest] = useState(false);

  const [e, setE] = useState<Editable>(() => ({
    tone_creativity: num(c.tone_creativity, 60),
    tone_formality: num(c.tone_formality, 50),
    tone_naturalness: num(c.tone_naturalness, 80),
    tone_aggressiveness: num(c.tone_aggressiveness, 50),
    custom_instructions: str(c.custom_instructions),
    confirmation_mode: (["always", "medium_and_high", "high_only"].includes(c.confirmation_mode)
      ? c.confirmation_mode
      : "medium_and_high") as ConfMode,
    data_fields: Array.isArray(c.data_fields) ? (c.data_fields as DataField[]) : [],
    follow_up_config: seedFollow(c.follow_up_config),
    working_hours: seedHours(c.working_hours),
    knowledge_base_instructions: str(c.knowledge_base_instructions),
    enabled_kbs: Array.isArray(c.enabled_kbs) ? (c.enabled_kbs as string[]) : [],
    max_messages_per_conversation: num(c.max_messages_per_conversation, 100),
    daily_proactive_limit: num(c.daily_proactive_limit, 10),
    quiet_hours: seedQuiet(c.quiet_hours),
  }));
  const patch = (p: Partial<Editable>) => setE((prev) => ({ ...prev, ...p }));

  const tabs: { id: Tab; label: string }[] = [
    { id: "config", label: "Configurações" },
    { id: "messages", label: "Mensagens" },
    { id: "docs", label: "Documentos" },
    { id: "history", label: "Histórico" },
  ];

  function toggleOpen(key: string) {
    setOpen((prev) => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });
  }

  async function toggleModule(key: string, next: boolean) {
    // otimista
    setEnabled((prev) => {
      const s = new Set(prev);
      if (next) s.add(key);
      else s.delete(key);
      return s;
    });
    try {
      const res = await fetch(`/api/agent-platform/agents/${detail.id}/modules`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module_key: key, enabled: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success(next ? "Módulo ligado" : "Módulo desligado");
    } catch (err) {
      // reverte
      setEnabled((prev) => {
        const s = new Set(prev);
        if (next) s.delete(key);
        else s.add(key);
        return s;
      });
      toast.error("Não consegui salvar o módulo. " + (err instanceof Error ? err.message : ""));
    }
  }

  async function save() {
    if (isSparkbot && !window.confirm("Isso altera a configuração do SparkBot em PRODUÇÃO. Salvar mesmo assim?")) return;
    setSaving(true);
    try {
      const body = {
        tone_creativity: e.tone_creativity,
        tone_formality: e.tone_formality,
        tone_naturalness: e.tone_naturalness,
        tone_aggressiveness: e.tone_aggressiveness,
        custom_instructions: e.custom_instructions,
        confirmation_mode: e.confirmation_mode,
        data_fields: e.data_fields,
        follow_up_config: e.follow_up_config,
        working_hours: e.working_hours,
        knowledge_base_instructions: e.knowledge_base_instructions,
        enabled_kbs: e.enabled_kbs,
        max_messages_per_conversation: e.max_messages_per_conversation,
        daily_proactive_limit: e.daily_proactive_limit,
        quiet_hours: e.quiet_hours,
      };
      const res = await fetch(`/api/agents/${detail.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success("Configurações salvas");
    } catch (err) {
      toast.error("Não consegui salvar. " + (err instanceof Error ? err.message : ""));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus() {
    const next = status === "active" ? "inactive" : "active";
    setTogglingStatus(true);
    try {
      const res = await fetch(`/api/agents/${detail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      setStatus(next === "active" ? "active" : "paused");
      toast.success(next === "active" ? "Agente ativado" : "Agente pausado");
      router.refresh();
    } catch (err) {
      toast.error("Não consegui mudar o status. " + (err instanceof Error ? err.message : ""));
    } finally {
      setTogglingStatus(false);
    }
  }

  return (
    <div>
      {/* Header */}
      <div style={{ padding: "20px 32px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <Link href="/hub/agents" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
          <ChevronLeft /> Voltar para agentes
        </Link>
        <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
          <AMark templateKey={detail.template_key} size="xl" />
          <div className="grow">
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 4 }}>
              {TEMPLATE_LABEL[detail.template_key] || detail.template_key}
            </div>
            <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.018em", margin: 0 }}>{detail.name}</h1>
            <div className="row wrap" style={{ gap: 16, marginTop: 8 }}>
              <StatusBadge status={status} />
              {detail.channels.map((c2) => (
                <ChannelChip key={c2} name={c2} />
              ))}
              <PriceBadge included={detail.included} entitled={detail.entitled} />
              {detail.since && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{detail.since}</span>}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn--ghost"
              onClick={() => setShowTest(true)}
              disabled={isSparkbot}
              title={isSparkbot ? "Teste o SparkBot direto no WhatsApp" : undefined}
            >
              <Play /> Testar
            </button>
            <button className="btn btn--ghost" onClick={toggleStatus} disabled={togglingStatus || status === "blocked"}>
              {status === "active" ? (
                <>
                  <Pause /> Pausar
                </>
              ) : (
                <>
                  <Play /> Ativar
                </>
              )}
            </button>
            <button className="btn btn--primary" onClick={save} disabled={saving}>
              <Check /> {saving ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ background: "var(--surface)", paddingLeft: 32, paddingRight: 32 }}>
        {tabs.map((t) => (
          <button key={t.id} className="tab" aria-current={tab === t.id ? "true" : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="page" style={{ maxWidth: 980 }}>
        {tab === "config" && (
          <div className="col" style={{ gap: 12 }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600 }}>Configurações</h2>
              <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
                <span className="bold" style={{ color: "var(--ink)" }}>
                  {enabled.size}
                </span>{" "}
                de {detail.modules.length} ajustes ligados.
              </p>
            </div>

            {detail.modules.map((m) => {
              const isOpen = open.has(m.key);
              const isOn = enabled.has(m.key);
              return (
                <div key={m.key} className="card" style={{ opacity: isOn ? 1 : 0.72 }}>
                  <div
                    onClick={() => toggleOpen(m.key)}
                    style={{
                      padding: "14px 18px",
                      display: "grid",
                      gridTemplateColumns: "auto 1fr auto auto",
                      gap: 14,
                      alignItems: "center",
                      cursor: "pointer",
                      borderBottom: isOpen ? "1px solid var(--line)" : "none",
                    }}
                  >
                    <span className={"modcat modcat--" + m.category} />
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{MODULE_LABEL[m.key] || m.name}</div>
                      <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>{MODULE_SUBTITLE[m.key] || ""}</div>
                    </div>
                    <div
                      className="switch"
                      aria-checked={isOn}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        toggleModule(m.key, !isOn);
                      }}
                    />
                    {isOpen ? (
                      <ChevronUp size={16} style={{ color: "var(--ink-3)" }} />
                    ) : (
                      <ChevronDown size={16} style={{ color: "var(--ink-3)" }} />
                    )}
                  </div>
                  {isOpen && <div style={{ padding: "16px 18px" }}>{renderBody(m.key, detail, e, patch)}</div>}
                </div>
              );
            })}
          </div>
        )}
        {tab === "messages" && <div className="empty">As conversas deste agente aparecerão aqui.</div>}
        {tab === "docs" && <div className="empty">Os documentos de apoio aparecerão aqui.</div>}
        {tab === "history" && <div className="empty">O histórico de alterações aparecerá aqui.</div>}
      </div>

      {showTest && (
        <TestChat agentId={detail.id} agentName={detail.name} templateKey={detail.template_key} onClose={() => setShowTest(false)} />
      )}
    </div>
  );
}

/* ─── Body dispatcher ───────────────────────────────────────────── */
function renderBody(key: string, detail: HubAgentDetail, e: Editable, patch: (p: Partial<Editable>) => void) {
  switch (key) {
    case "behavior":
      return <BehaviorBody e={e} patch={patch} />;
    case "qualification":
      return <QualBody e={e} patch={patch} />;
    case "followup":
      return <FollowupBody e={e} patch={patch} />;
    case "active_hours":
      return <HoursBody e={e} patch={patch} />;
    case "knowledge":
      return <KnowledgeBody e={e} patch={patch} />;
    case "compliance":
      return <ComplianceBody e={e} patch={patch} />;
    case "channel":
      return <ChannelReadBody detail={detail} />;
    default:
      return <NoteBody />;
  }
}

/* ─── FRow + Slider ─────────────────────────────────────────────── */
function FRow({ label, hint, children, full }: { label: string; hint?: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: full ? "1fr" : "220px 1fr",
        gap: 18,
        padding: "12px 0",
        borderBottom: "1px solid var(--line-faint)",
      }}
    >
      <div>
        <div style={{ fontWeight: 500, fontSize: 13.5 }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Sld({ label, left, right, value, onChange }: { label: string; left: string; right: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 13 }}>{label}</span>
        <span className="tnum" style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {value}
        </span>
      </div>
      <input className="slider" type="range" min={0} max={100} value={value} onChange={(ev) => onChange(Number(ev.target.value))} />
      <div className="row between" style={{ marginTop: 3, fontSize: 11, color: "var(--ink-4)" }}>
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

/* ─── Bodies ────────────────────────────────────────────────────── */
function BehaviorBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const modes: { v: ConfMode; l: string }[] = [
    { v: "always", l: "Sempre — pergunta antes de qualquer ação" },
    { v: "medium_and_high", l: "Em ações importantes (padrão)" },
    { v: "high_only", l: "Só nas ações mais sensíveis" },
  ];
  return (
    <>
      <FRow label="Personalidade" hint="Como o agente se comunica.">
        <Sld label="Criatividade" left="Conservador" right="Criativo" value={e.tone_creativity} onChange={(v) => patch({ tone_creativity: v })} />
        <Sld label="Formalidade" left="Casual" right="Formal" value={e.tone_formality} onChange={(v) => patch({ tone_formality: v })} />
        <Sld label="Naturalidade" left="Robótico" right="Humano" value={e.tone_naturalness} onChange={(v) => patch({ tone_naturalness: v })} />
        <Sld label="Assertividade" left="Tímido" right="Direto" value={e.tone_aggressiveness} onChange={(v) => patch({ tone_aggressiveness: v })} />
      </FRow>
      <FRow label="Instruções customizadas" hint="O que ele precisa saber sobre sua agência." full>
        <textarea
          className="textarea"
          rows={4}
          value={e.custom_instructions}
          maxLength={10000}
          onChange={(ev) => patch({ custom_instructions: ev.target.value })}
          placeholder="Ex: Você é a assistente de vendas da Pereira Seguros. Foco em planos de saúde para famílias brasileiras na Flórida."
        />
      </FRow>
      <FRow label="Quando pedir confirmação" hint="Antes de fazer ações no Spark Leads.">
        <div className="col" style={{ gap: 6 }}>
          {modes.map((o) => (
            <label key={o.v} className="row" style={{ gap: 10, fontSize: 13 }}>
              <input type="radio" name="conf" checked={e.confirmation_mode === o.v} onChange={() => patch({ confirmation_mode: o.v })} />
              <span>{o.l}</span>
            </label>
          ))}
        </div>
      </FRow>
    </>
  );
}

function QualBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const fields = e.data_fields;
  const update = (i: number, p: Partial<DataField>) => {
    const next = fields.map((f, idx) => (idx === i ? { ...f, ...p } : f));
    patch({ data_fields: next });
  };
  const add = () => patch({ data_fields: [...fields, { key: `campo_${fields.length + 1}`, label: "Nova pergunta", required: false, type: "text" }] });
  const remove = (i: number) => patch({ data_fields: fields.filter((_, idx) => idx !== i) });
  return (
    <FRow label="Perguntas que o agente faz" hint="Para identificar um bom lead." full>
      <div className="col" style={{ gap: 8 }}>
        {fields.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nenhuma pergunta configurada.</div>}
        {fields.map((f, i) => (
          <div
            key={i}
            className="card card--flat"
            style={{ padding: 10, display: "grid", gridTemplateColumns: "1fr 120px auto auto", gap: 10, alignItems: "center", background: "var(--surface-2)" }}
          >
            <input
              className="input"
              value={f.label}
              onChange={(ev) => update(i, { label: ev.target.value, key: f.key || slug(ev.target.value) })}
            />
            <select className="select" value={f.type} onChange={(ev) => update(i, { type: ev.target.value as DataField["type"] })}>
              <option value="text">Texto</option>
              <option value="date">Data</option>
              <option value="boolean">Sim/Não</option>
              <option value="select">Opções</option>
            </select>
            <label className="row" style={{ gap: 6, fontSize: 12 }}>
              <div className="switch" aria-checked={f.required} onClick={() => update(i, { required: !f.required })} /> obrig.
            </label>
            <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remove(i)} title="Remover">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={add}>
          <Plus /> Nova pergunta
        </button>
      </div>
    </FRow>
  );
}

function FollowupBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const f = e.follow_up_config;
  const set = (p: Partial<FollowUpConfig>) => patch({ follow_up_config: { ...f, ...p } });
  return (
    <>
      <FRow label="Ativar follow-up" hint="Retomar quem não respondeu.">
        <div className="switch" aria-checked={f.enabled} onClick={() => set({ enabled: !f.enabled })} />
      </FRow>
      <FRow label="Modo">
        <div className="row" style={{ gap: 6 }}>
          {(["ai_auto", "manual"] as const).map((mode) => (
            <button
              key={mode}
              className={"btn btn--sm " + (f.mode === mode ? "btn--primary" : "btn--ghost")}
              onClick={() => set({ mode })}
            >
              {mode === "ai_auto" ? "Automático (IA decide)" : "Manual (passos fixos)"}
            </button>
          ))}
        </div>
      </FRow>
      {f.mode === "ai_auto" && (
        <FRow label="Intensidade" hint="1 = leve · 10 = insistente.">
          <input className="input" type="number" min={1} max={10} value={f.intensity} onChange={(ev) => set({ intensity: Number(ev.target.value) })} style={{ width: 90 }} />
        </FRow>
      )}
      <FRow label="Máximo de tentativas">
        <input className="input" type="number" min={1} max={20} value={f.max_attempts} onChange={(ev) => set({ max_attempts: Number(ev.target.value) })} style={{ width: 90 }} />
      </FRow>
    </>
  );
}

function HoursBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const w = e.working_hours;
  const set = (p: Partial<WorkingHoursConfig>) => patch({ working_hours: { ...w, ...p } });
  return (
    <>
      <FRow label="Limitar horário" hint="Quando o agente pode responder.">
        <div className="switch" aria-checked={w.enabled} onClick={() => set({ enabled: !w.enabled })} />
      </FRow>
      <FRow label="Fuso horário">
        <input className="input" value={w.timezone} onChange={(ev) => set({ timezone: ev.target.value })} placeholder="America/New_York" />
      </FRow>
      <FRow label="Aplicar como">
        <select className="select" value={w.mode} onChange={(ev) => set({ mode: ev.target.value as WorkingHoursConfig["mode"] })}>
          <option value="only_during">Só responder DENTRO do horário</option>
          <option value="only_outside">Só responder FORA do horário</option>
        </select>
      </FRow>
    </>
  );
}

function KnowledgeBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const KBS: { v: string; l: string }[] = [
    { v: "national_life_group", l: "National Life Group" },
    { v: "agency_brazillionaires", l: "Brazillionaires" },
  ];
  const toggleKb = (v: string) => {
    const has = e.enabled_kbs.includes(v);
    patch({ enabled_kbs: has ? e.enabled_kbs.filter((k) => k !== v) : [...e.enabled_kbs, v] });
  };
  return (
    <>
      <FRow label="Bases de conhecimento" hint="O agente consulta antes de responder.">
        <div className="col" style={{ gap: 8 }}>
          {KBS.map((kb) => (
            <label key={kb.v} className="row" style={{ gap: 10, fontSize: 13.5 }}>
              <div className="switch" aria-checked={e.enabled_kbs.includes(kb.v)} onClick={() => toggleKb(kb.v)} /> {kb.l}
            </label>
          ))}
        </div>
      </FRow>
      <FRow label="Instruções de uso" hint="Como usar os documentos." full>
        <textarea
          className="textarea"
          rows={3}
          maxLength={10000}
          value={e.knowledge_base_instructions}
          onChange={(ev) => patch({ knowledge_base_instructions: ev.target.value })}
          placeholder="Ex: Use a tabela de preços só para planos família. Não cite valores sem confirmar o estado."
        />
      </FRow>
    </>
  );
}

function ComplianceBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const q = e.quiet_hours;
  const setQ = (p: Partial<Quiet>) => patch({ quiet_hours: { ...q, ...p } });
  return (
    <>
      <FRow label="Máx. mensagens por conversa">
        <input
          className="input"
          type="number"
          min={10}
          max={200}
          value={e.max_messages_per_conversation}
          onChange={(ev) => patch({ max_messages_per_conversation: Number(ev.target.value) })}
          style={{ width: 100 }}
        />
      </FRow>
      <FRow label="Limite de proativos por dia" hint="Quantas vezes pode iniciar conversa.">
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          value={e.daily_proactive_limit}
          onChange={(ev) => patch({ daily_proactive_limit: Number(ev.target.value) })}
          style={{ width: 100 }}
        />
      </FRow>
      <FRow label="Horário de silêncio" hint="Não envia mensagens nesse intervalo.">
        <div className="row" style={{ gap: 8 }}>
          <div className="switch" aria-checked={q.enabled} onClick={() => setQ({ enabled: !q.enabled })} />
          {q.enabled && (
            <>
              <input className="input" value={q.start} onChange={(ev) => setQ({ start: ev.target.value })} style={{ width: 90 }} />
              <span className="muted">até</span>
              <input className="input" value={q.end} onChange={(ev) => setQ({ end: ev.target.value })} style={{ width: 90 }} />
            </>
          )}
        </div>
      </FRow>
    </>
  );
}

function ChannelReadBody({ detail }: { detail: HubAgentDetail }) {
  return (
    <FRow label="Canais ativos" hint="Provisionados pela agência." full>
      <div className="row wrap" style={{ gap: 10 }}>
        {detail.channels.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Nenhum canal conectado.</span>
        ) : (
          detail.channels.map((c) => <ChannelChip key={c} name={c} />)
        )}
      </div>
    </FRow>
  );
}

function NoteBody() {
  return <div className="muted" style={{ fontSize: 13 }}>Os ajustes finos deste módulo entram em breve. Por ora, ligar/desligar já vale.</div>;
}
