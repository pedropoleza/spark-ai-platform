"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft, X, Play, Pause, Check, Plus, Trash2,
  Sparkles, Clock, Calendar, MessageCircle, Users, Send, Mail, Layers, FileText, Shield,
  type LucideIcon,
} from "lucide-react";
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

const MODULE_ICON: Record<string, LucideIcon> = {
  behavior: Sparkles,
  active_hours: Clock,
  scheduling: Calendar,
  channel: MessageCircle,
  qualification: Users,
  followup: Send,
  bulk: Mail,
  crm_ops: Layers,
  knowledge: FileText,
  compliance: Shield,
};

// Agrupamento por seção — dá estrutura em vez de uma lista chapada.
const GROUPS: { title: string; keys: string[] }[] = [
  { title: "Comportamento", keys: ["behavior"] },
  { title: "Atendimento", keys: ["active_hours", "scheduling", "channel"] },
  { title: "Leads e mensagens", keys: ["qualification", "followup", "bulk"] },
  { title: "Operação e limites", keys: ["crm_ops", "knowledge", "compliance"] },
];

type ConfMode = "always" | "medium_and_high" | "high_only";
type Tab = "config" | "messages" | "docs" | "history";

const num = (v: unknown, d: number) => (typeof v === "number" && !isNaN(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSeed(c: Record<string, any>): Editable {
  return {
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
  };
}

export function AgentDetailView({ detail }: { detail: HubAgentDetail }) {
  const router = useRouter();
  const isSparkbot = detail.template_key === "sparkbot";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (detail.config ?? {}) as Record<string, any>;
  const aiModel = str(c.ai_model) || "padrão";

  const [tab, setTab] = useState<Tab>("config");
  const [status, setStatus] = useState<AgentStatus>(detail.status);
  const [enabled, setEnabled] = useState<Set<string>>(new Set(detail.modules.filter((m) => m.enabled).map((m) => m.key)));
  const [drawer, setDrawer] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [e, setE] = useState<Editable>(() => makeSeed(c));
  const patch = (p: Partial<Editable>) => {
    setE((prev) => ({ ...prev, ...p }));
    setDirty(true);
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "config", label: "Configurações" },
    { id: "messages", label: "Mensagens" },
    { id: "docs", label: "Documentos" },
    { id: "history", label: "Histórico" },
  ];

  async function toggleModule(key: string, next: boolean) {
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
      toast.success(next ? "Ajuste ligado" : "Ajuste desligado");
    } catch (err) {
      setEnabled((prev) => {
        const s = new Set(prev);
        if (next) s.delete(key);
        else s.add(key);
        return s;
      });
      toast.error("Não consegui salvar. " + (err instanceof Error ? err.message : ""));
    }
  }

  async function save() {
    if (isSparkbot && !window.confirm("Isso altera a configuração do SparkBot em PRODUÇÃO. Salvar mesmo assim?")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${detail.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      setDirty(false);
      toast.success("Configurações salvas");
    } catch (err) {
      toast.error("Não consegui salvar. " + (err instanceof Error ? err.message : ""));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setE(makeSeed(c));
    setDirty(false);
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

  // módulos presentes neste agente, indexados por key
  const byKey = new Map(detail.modules.map((m) => [m.key, m]));
  const groupsToRender = GROUPS.map((g) => ({ title: g.title, mods: g.keys.filter((k) => byKey.has(k)) })).filter((g) => g.mods.length > 0);
  const ungrouped = detail.modules.filter((m) => !GROUPS.some((g) => g.keys.includes(m.key))).map((m) => m.key);
  if (ungrouped.length) groupsToRender.push({ title: "Outros", mods: ungrouped });

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

      <div className="page" style={{ maxWidth: 860 }}>
        {tab === "config" && (
          <>
            <div className="cfg-summary">{buildSummary(e, detail)}</div>

            {groupsToRender.map((g) => (
              <div key={g.title}>
                <div className="cfg-group-title">{g.title}</div>
                <div className="cfg-grid">
                  {g.mods.map((key) => {
                    const Icon = MODULE_ICON[key] || Sparkles;
                    const isOn = enabled.has(key);
                    return (
                      <div
                        key={key}
                        className="cfg-tile"
                        data-on={isOn}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDrawer(key)}
                        onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && setDrawer(key)}
                      >
                        <div className="cfg-tile__icon"><Icon /></div>
                        <div style={{ minWidth: 0 }}>
                          <div className="cfg-tile__title">{MODULE_LABEL[key] || key}</div>
                          <div className="cfg-tile__sum">{isOn ? summarize(key, e, detail) : "Desligado"}</div>
                        </div>
                        <div
                          className="switch"
                          role="switch"
                          aria-checked={isOn}
                          tabIndex={0}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            toggleModule(key, !isOn);
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.stopPropagation();
                              ev.preventDefault();
                              toggleModule(key, !isOn);
                            }
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {dirty && (
              <div className="cfg-savebar">
                <span className="cfg-savebar__msg">
                  <span className="cfg-savebar__dot" /> Você tem alterações não salvas
                </span>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn--on-dark btn--sm" onClick={discard} disabled={saving}>
                    Descartar
                  </button>
                  <button className="btn btn--primary btn--sm" onClick={save} disabled={saving}>
                    <Check /> {saving ? "Salvando…" : "Salvar alterações"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {tab === "messages" && <div className="empty">As conversas deste agente aparecerão aqui.</div>}
        {tab === "docs" && <div className="empty">Os documentos de apoio aparecerão aqui.</div>}
        {tab === "history" && <div className="empty">O histórico de alterações aparecerá aqui.</div>}
      </div>

      {drawer && (
        <>
          <div className="drawer-overlay" onClick={() => setDrawer(null)} />
          <aside className="drawer" role="dialog" aria-label={MODULE_LABEL[drawer] || drawer}>
            <div className="drawer__hd">
              <div className="row" style={{ gap: 10 }}>
                {(() => {
                  const I = MODULE_ICON[drawer] || Sparkles;
                  return (
                    <div className="cfg-tile__icon">
                      <I />
                    </div>
                  );
                })()}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{MODULE_LABEL[drawer] || drawer}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{MODULE_SUBTITLE[drawer] || ""}</div>
                </div>
              </div>
              <button className="btn btn--quiet btn--icon" onClick={() => setDrawer(null)} aria-label="Fechar">
                <X />
              </button>
            </div>
            <div className="drawer__body">
              {enabled.has(drawer) ? (
                renderBody(drawer, detail, e, patch, aiModel)
              ) : (
                <div className="col" style={{ gap: 12, padding: "12px 0" }}>
                  <p className="muted" style={{ fontSize: 13.5 }}>Este ajuste está desligado.</p>
                  <button className="btn btn--primary btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => toggleModule(drawer, true)}>
                    Ligar este ajuste
                  </button>
                </div>
              )}
            </div>
            <div className="drawer__foot">
              <button className="btn btn--primary" onClick={() => setDrawer(null)}>
                Concluir
              </button>
            </div>
          </aside>
        </>
      )}

      {showTest && (
        <TestChat agentId={detail.id} agentName={detail.name} templateKey={detail.template_key} onClose={() => setShowTest(false)} />
      )}
    </div>
  );
}

/* ─── Resumos do painel de controle ─────────────────────────────── */
function summarize(key: string, e: Editable, detail: HubAgentDetail): string {
  switch (key) {
    case "behavior":
      return `${e.tone_formality >= 55 ? "Formal" : "Casual"}, ${e.tone_naturalness >= 60 ? "humano" : "objetivo"}`;
    case "active_hours":
      return e.working_hours.enabled ? "Horário limitado" : "Sempre disponível";
    case "scheduling":
      return "Marcar reuniões";
    case "channel":
      return detail.channels.length
        ? detail.channels.map((c) => (c === "whatsapp" ? "WhatsApp" : "Instagram")).join(", ")
        : "Sem canal";
    case "qualification":
      return e.data_fields.length ? `${e.data_fields.length} pergunta${e.data_fields.length > 1 ? "s" : ""}` : "Sem perguntas";
    case "followup":
      return e.follow_up_config.enabled ? `${e.follow_up_config.max_attempts} tentativas` : "Desligado";
    case "bulk":
      return "Campanhas";
    case "crm_ops":
      return "Ações no CRM";
    case "knowledge":
      return e.enabled_kbs.length ? `${e.enabled_kbs.length} base${e.enabled_kbs.length > 1 ? "s" : ""}` : "Sem documentos";
    case "compliance":
      return `máx ${e.max_messages_per_conversation}/conversa`;
    default:
      return "Configurar";
  }
}

function buildSummary(e: Editable, detail: HubAgentDetail): React.ReactNode {
  const form = e.tone_formality >= 55 ? "formal" : "informal";
  const nat = e.tone_naturalness >= 60 ? "natural" : "objetivo";
  const hours = e.working_hours.enabled ? "em horário definido" : "a qualquer hora";
  const fup = e.follow_up_config.enabled ? `faz até ${e.follow_up_config.max_attempts} follow-ups` : "não faz follow-up";
  const qn = e.data_fields.length;
  const ch = detail.channels.length
    ? detail.channels.map((c) => (c === "whatsapp" ? "WhatsApp" : "Instagram")).join(" e ")
    : "—";
  return (
    <>
      Esse agente fala de forma <b>{nat}</b> e <b>{form}</b> no <b>{ch}</b>, atende <b>{hours}</b> e <b>{fup}</b>
      {qn > 0 ? (
        <>
          , coletando <b>{qn} informaç{qn > 1 ? "ões" : "ão"}</b>
        </>
      ) : null}
      .
    </>
  );
}

/* ─── Body dispatcher ───────────────────────────────────────────── */
function renderBody(key: string, detail: HubAgentDetail, e: Editable, patch: (p: Partial<Editable>) => void, aiModel: string) {
  switch (key) {
    case "behavior":
      return <BehaviorBody e={e} patch={patch} aiModel={aiModel} />;
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

/* ─── Field (stacked) + Slider + Seg ────────────────────────────── */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fstack">
      <div className="fstack__lbl">{label}</div>
      {hint && <div className="fstack__hint">{hint}</div>}
      <div>{children}</div>
    </div>
  );
}

function Sld({ label, left, right, value, onChange }: { label: string; left: string; right: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="row between" style={{ marginBottom: 5 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        <span className="tnum" style={{ fontSize: 12, color: "var(--primary)", fontWeight: 600 }}>{value}</span>
      </div>
      <input className="slider" type="range" min={0} max={100} value={value} onChange={(ev) => onChange(Number(ev.target.value))} />
      <div className="row between" style={{ marginTop: 4, fontSize: 11, color: "var(--ink-4)" }}>
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

/* ─── Bodies ────────────────────────────────────────────────────── */
function BehaviorBody({ e, patch, aiModel }: { e: Editable; patch: (p: Partial<Editable>) => void; aiModel: string }) {
  const modes: { v: ConfMode; l: string }[] = [
    { v: "always", l: "Sempre — pergunta antes de qualquer ação" },
    { v: "medium_and_high", l: "Em ações importantes (recomendado)" },
    { v: "high_only", l: "Só nas ações mais sensíveis" },
  ];
  return (
    <>
      <Field label="Personalidade" hint="Como o agente se comunica com as pessoas.">
        <Sld label="Criatividade" left="Conservador" right="Criativo" value={e.tone_creativity} onChange={(v) => patch({ tone_creativity: v })} />
        <Sld label="Formalidade" left="Casual" right="Formal" value={e.tone_formality} onChange={(v) => patch({ tone_formality: v })} />
        <Sld label="Naturalidade" left="Robótico" right="Humano" value={e.tone_naturalness} onChange={(v) => patch({ tone_naturalness: v })} />
        <Sld label="Assertividade" left="Tímido" right="Direto" value={e.tone_aggressiveness} onChange={(v) => patch({ tone_aggressiveness: v })} />
      </Field>
      <Field label="Instruções customizadas" hint="O que ele precisa saber sobre sua agência e como agir.">
        <textarea
          className="textarea"
          rows={5}
          value={e.custom_instructions}
          maxLength={10000}
          onChange={(ev) => patch({ custom_instructions: ev.target.value })}
          placeholder="Ex: Você é a assistente de vendas da Pereira Seguros. Foco em planos de saúde para famílias brasileiras na Flórida. Sempre proponha uma ligação de 20 minutos."
        />
      </Field>
      <Field label="Quando pedir confirmação" hint="Antes de fazer ações no Spark Leads.">
        <div className="col" style={{ gap: 8 }}>
          {modes.map((o) => (
            <label key={o.v} className="row" style={{ gap: 10, fontSize: 13.5, cursor: "pointer" }}>
              <input type="radio" name="conf" checked={e.confirmation_mode === o.v} onChange={() => patch({ confirmation_mode: o.v })} />
              <span>{o.l}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label="Modelo de IA">
        <span className="pill pill--muted">{aiModel}</span>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>gerenciado pelo Spark</span>
      </Field>
    </>
  );
}

function QualBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const fields = e.data_fields;
  const update = (i: number, p: Partial<DataField>) => patch({ data_fields: fields.map((f, idx) => (idx === i ? { ...f, ...p } : f)) });
  const add = () => patch({ data_fields: [...fields, { key: `campo_${fields.length + 1}`, label: "Nova pergunta", required: false, type: "text" }] });
  const remove = (i: number) => patch({ data_fields: fields.filter((_, idx) => idx !== i) });
  return (
    <Field label="Perguntas que o agente faz" hint="Para identificar um bom lead. Arraste a ordem depois.">
      <div className="col" style={{ gap: 8 }}>
        {fields.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nenhuma pergunta configurada.</div>}
        {fields.map((f, i) => (
          <div
            key={i}
            style={{ display: "grid", gridTemplateColumns: "1fr 120px auto auto", gap: 10, alignItems: "center", background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8 }}
          >
            <input className="input" value={f.label} onChange={(ev) => update(i, { label: ev.target.value })} />
            <select className="select" value={f.type} onChange={(ev) => update(i, { type: ev.target.value as DataField["type"] })}>
              <option value="text">Texto</option>
              <option value="date">Data</option>
              <option value="boolean">Sim/Não</option>
              <option value="select">Opções</option>
            </select>
            <label className="row" style={{ gap: 6, fontSize: 12, color: "var(--ink-3)" }}>
              <div className="switch" aria-checked={f.required} role="switch" onClick={() => update(i, { required: !f.required })} /> obrig.
            </label>
            <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remove(i)} title="Remover" aria-label="Remover">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start", marginTop: 2 }} onClick={add}>
          <Plus /> Nova pergunta
        </button>
      </div>
    </Field>
  );
}

function FollowupBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const f = e.follow_up_config;
  const set = (p: Partial<FollowUpConfig>) => patch({ follow_up_config: { ...f, ...p } });
  return (
    <>
      <Field label="Ativar follow-up" hint="Retomar automaticamente quem não respondeu.">
        <div className="switch" aria-checked={f.enabled} role="switch" onClick={() => set({ enabled: !f.enabled })} />
      </Field>
      {f.enabled && (
        <>
          <Field label="Como decidir as mensagens">
            <Seg
              value={f.mode}
              options={[
                { v: "ai_auto", l: "IA decide" },
                { v: "manual", l: "Passos fixos" },
              ]}
              onChange={(mode) => set({ mode })}
            />
          </Field>
          {f.mode === "ai_auto" && (
            <Field label="Intensidade" hint="1 = leve · 10 = insistente.">
              <input className="input" type="number" min={1} max={10} value={f.intensity} onChange={(ev) => set({ intensity: Number(ev.target.value) })} style={{ width: 100 }} />
            </Field>
          )}
          <Field label="Máximo de tentativas">
            <input className="input" type="number" min={1} max={20} value={f.max_attempts} onChange={(ev) => set({ max_attempts: Number(ev.target.value) })} style={{ width: 100 }} />
          </Field>
        </>
      )}
    </>
  );
}

function HoursBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const w = e.working_hours;
  const set = (p: Partial<WorkingHoursConfig>) => patch({ working_hours: { ...w, ...p } });
  return (
    <>
      <Field label="Limitar horário de atendimento" hint="Quando o agente pode responder.">
        <div className="switch" aria-checked={w.enabled} role="switch" onClick={() => set({ enabled: !w.enabled })} />
      </Field>
      {w.enabled && (
        <>
          <Field label="Fuso horário">
            <input className="input" value={w.timezone} onChange={(ev) => set({ timezone: ev.target.value })} placeholder="America/New_York" style={{ maxWidth: 280 }} />
          </Field>
          <Field label="Aplicar como">
            <Seg
              value={w.mode}
              options={[
                { v: "only_during", l: "Responder no horário" },
                { v: "only_outside", l: "Responder fora dele" },
              ]}
              onChange={(mode) => set({ mode })}
            />
          </Field>
        </>
      )}
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
      <Field label="Bases de conhecimento" hint="O agente consulta antes de responder.">
        <div className="col" style={{ gap: 10 }}>
          {KBS.map((kb) => (
            <label key={kb.v} className="row" style={{ gap: 10, fontSize: 13.5, cursor: "pointer" }}>
              <div className="switch" aria-checked={e.enabled_kbs.includes(kb.v)} role="switch" onClick={() => toggleKb(kb.v)} /> {kb.l}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Instruções de uso" hint="Como o agente deve usar os documentos.">
        <textarea
          className="textarea"
          rows={3}
          maxLength={10000}
          value={e.knowledge_base_instructions}
          onChange={(ev) => patch({ knowledge_base_instructions: ev.target.value })}
          placeholder="Ex: Use a tabela de preços só para planos família. Não cite valores sem confirmar o estado."
        />
      </Field>
    </>
  );
}

function ComplianceBody({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const q = e.quiet_hours;
  const setQ = (p: Partial<Quiet>) => patch({ quiet_hours: { ...q, ...p } });
  return (
    <>
      <Field label="Máximo de mensagens por conversa">
        <input className="input" type="number" min={10} max={200} value={e.max_messages_per_conversation} onChange={(ev) => patch({ max_messages_per_conversation: Number(ev.target.value) })} style={{ width: 110 }} />
      </Field>
      <Field label="Limite de proativos por dia" hint="Quantas vezes pode iniciar conversa.">
        <input className="input" type="number" min={0} max={100} value={e.daily_proactive_limit} onChange={(ev) => patch({ daily_proactive_limit: Number(ev.target.value) })} style={{ width: 110 }} />
      </Field>
      <Field label="Horário de silêncio" hint="Não envia nesse intervalo.">
        <div className="row" style={{ gap: 8 }}>
          <div className="switch" aria-checked={q.enabled} role="switch" onClick={() => setQ({ enabled: !q.enabled })} />
          {q.enabled && (
            <>
              <input className="input" value={q.start} onChange={(ev) => setQ({ start: ev.target.value })} style={{ width: 90 }} />
              <span className="muted">até</span>
              <input className="input" value={q.end} onChange={(ev) => setQ({ end: ev.target.value })} style={{ width: 90 }} />
            </>
          )}
        </div>
      </Field>
    </>
  );
}

function ChannelReadBody({ detail }: { detail: HubAgentDetail }) {
  return (
    <Field label="Canais ativos" hint="Conectados e provisionados pela agência.">
      <div className="row wrap" style={{ gap: 10 }}>
        {detail.channels.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Nenhum canal conectado.</span>
        ) : (
          detail.channels.map((ch) => <ChannelChip key={ch} name={ch} />)
        )}
      </div>
    </Field>
  );
}

function NoteBody() {
  return <div className="muted" style={{ fontSize: 13 }}>Os ajustes finos deste módulo entram em breve. Por ora, ligar/desligar já vale.</div>;
}
