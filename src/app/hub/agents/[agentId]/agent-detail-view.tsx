"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft, Play, Pause, Check, Plus, Trash2,
  Sparkles, Clock, Calendar, MessageCircle, Users, Send, FileText, Shield,
  type LucideIcon,
} from "lucide-react";
import { AMark, StatusBadge, ChannelChip, PriceBadge } from "@/components/hub/primitives";
import { TestChat } from "./test-chat";
import type { HubAgentDetail } from "@/lib/hub/data";
import type { AgentStatus, ChannelKey } from "@/components/hub/types";
import { channelsFromDb, channelsToDb, CHANNEL_LABEL } from "@/components/hub/types";
import type { DataField, FollowUpConfig, WorkingHoursConfig } from "@/types/agent";

const TEMPLATE_LABEL: Record<string, string> = { sparkbot: "SparkBot", sales: "Vendas", recruitment: "Recrutamento", custom: "Personalizado" };

type ConfMode = "always" | "medium_and_high" | "high_only";
type Objective = "qualification_only" | "qualification_and_booking" | "booking_only";
type Cat = "personality" | "channel" | "hours" | "qualification" | "followup" | "scheduling" | "knowledge" | "limits" | "messages" | "docs" | "history";

const num = (v: unknown, d: number) => (typeof v === "number" && !isNaN(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);

interface Quiet { enabled: boolean; start: string; end: string; timezone?: string; days?: number[] }
interface PostBooking { behavior: "stop_and_handoff" | "continue_until_appointment"; handoff_message: string; allow_reschedule: boolean }
interface Notif { on_qualified: boolean; on_booked: boolean; on_handed_off: boolean; on_error: boolean; notification_email: string }

interface Editable {
  identity_name: string;
  identity_mode: "assistant" | "human";
  persona_description: string;
  pers_greeting: string;
  pers_farewell: string;
  pers_language: string;
  tone_creativity: number; tone_formality: number; tone_naturalness: number; tone_aggressiveness: number;
  custom_instructions: string;
  conversation_examples: string;
  confirmation_mode: ConfMode;
  objective: Objective;
  working_hours: WorkingHoursConfig;
  debounce_seconds: number;
  auto_pause_on_human_message: boolean;
  data_fields: DataField[];
  channels: ChannelKey[];
  follow_up_config: FollowUpConfig;
  post_booking: PostBooking;
  knowledge_base_instructions: string;
  enabled_kbs: string[];
  max_messages_per_conversation: number;
  daily_proactive_limit: number;
  no_response_threshold: number;
  quiet_hours: Quiet;
  enable_audio_transcription: boolean;
  enable_image_analysis: boolean;
  enable_pdf_reading: boolean;
  enable_summary_notes: boolean;
  notifications: Notif;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSeed(c: Record<string, any>): Editable {
  const p = (c.personality ?? {}) as Record<string, unknown>;
  const fu = (c.follow_up_config ?? {}) as Partial<FollowUpConfig>;
  const wh = (c.working_hours ?? {}) as Partial<WorkingHoursConfig>;
  const pb = (c.post_booking ?? {}) as Partial<PostBooking>;
  const qh = (c.quiet_hours ?? {}) as Partial<Quiet>;
  const nt = (c.notifications ?? {}) as Partial<Notif>;
  return {
    identity_name: str(p.name),
    identity_mode: p.identity_mode === "human" ? "human" : "assistant",
    persona_description: str(p.persona_description),
    pers_greeting: str(p.greeting_style),
    pers_farewell: str(p.farewell_style),
    pers_language: str(p.language) || "pt-BR",
    tone_creativity: num(c.tone_creativity, 60),
    tone_formality: num(c.tone_formality, 50),
    tone_naturalness: num(c.tone_naturalness, 80),
    tone_aggressiveness: num(c.tone_aggressiveness, 50),
    custom_instructions: str(c.custom_instructions),
    conversation_examples: str(c.conversation_examples),
    confirmation_mode: (["always", "medium_and_high", "high_only"].includes(c.confirmation_mode) ? c.confirmation_mode : "medium_and_high") as ConfMode,
    objective: (["qualification_only", "qualification_and_booking", "booking_only"].includes(c.objective) ? c.objective : "qualification_and_booking") as Objective,
    working_hours: { enabled: bool(wh.enabled), timezone: str(wh.timezone) || "America/New_York", mode: wh.mode === "only_outside" ? "only_outside" : "only_during", schedule: (wh.schedule as WorkingHoursConfig["schedule"]) || {} },
    debounce_seconds: num(c.debounce_seconds, 10),
    auto_pause_on_human_message: bool(c.auto_pause_on_human_message, true),
    data_fields: Array.isArray(c.data_fields) ? (c.data_fields as DataField[]) : [],
    channels: channelsFromDb(c.enabled_channels),
    follow_up_config: {
      enabled: bool(fu.enabled), mode: fu.mode === "manual" ? "manual" : "ai_auto",
      intensity: num(fu.intensity, 5), max_attempts: num(fu.max_attempts, 3),
      min_delay_minutes: num(fu.min_delay_minutes, 10), max_delay_minutes: num(fu.max_delay_minutes, 10080),
      custom_prompt: str(fu.custom_prompt), manual_steps: Array.isArray(fu.manual_steps) ? fu.manual_steps : [],
    },
    post_booking: { behavior: pb.behavior === "continue_until_appointment" ? "continue_until_appointment" : "stop_and_handoff", handoff_message: str(pb.handoff_message), allow_reschedule: bool(pb.allow_reschedule, true) },
    knowledge_base_instructions: str(c.knowledge_base_instructions),
    enabled_kbs: Array.isArray(c.enabled_kbs) ? (c.enabled_kbs as string[]) : [],
    max_messages_per_conversation: num(c.max_messages_per_conversation, 100),
    daily_proactive_limit: num(c.daily_proactive_limit, 10),
    no_response_threshold: num(c.no_response_threshold, 3),
    quiet_hours: { enabled: bool(qh.enabled), start: str(qh.start) || "21:00", end: str(qh.end) || "08:00", timezone: qh.timezone, days: qh.days },
    enable_audio_transcription: bool(c.enable_audio_transcription, true),
    enable_image_analysis: bool(c.enable_image_analysis, true),
    enable_pdf_reading: bool(c.enable_pdf_reading, true),
    enable_summary_notes: bool(c.enable_summary_notes, false),
    notifications: { on_qualified: bool(nt.on_qualified, true), on_booked: bool(nt.on_booked, true), on_handed_off: bool(nt.on_handed_off, false), on_error: bool(nt.on_error, true), notification_email: str(nt.notification_email) },
  };
}

// Categoria → módulo do catálogo (visibilidade + toggle único).
const CAT_MODULE: Partial<Record<Cat, string>> = {
  personality: "behavior", channel: "channel", hours: "active_hours",
  qualification: "qualification", followup: "followup", scheduling: "scheduling",
  knowledge: "knowledge", limits: "compliance",
};
// Categorias com toggle mestre (ligar/desligar a capacidade). As demais são sempre-on.
const TOGGLE_CATS = new Set<Cat>(["hours", "qualification", "followup", "scheduling", "knowledge"]);
// Sempre visíveis (independente de módulo).
const ALWAYS_CATS = new Set<Cat>(["personality", "limits"]);

const CATS: { id: Cat; label: string; icon: LucideIcon; group: "config" | "agent" }[] = [
  { id: "personality", label: "Personalidade", icon: Sparkles, group: "config" },
  { id: "channel", label: "Canais", icon: MessageCircle, group: "config" },
  { id: "hours", label: "Horário", icon: Clock, group: "config" },
  { id: "qualification", label: "Qualificação", icon: Users, group: "config" },
  { id: "followup", label: "Follow-up", icon: Send, group: "config" },
  { id: "scheduling", label: "Agendamento", icon: Calendar, group: "config" },
  { id: "knowledge", label: "Conhecimento", icon: FileText, group: "config" },
  { id: "limits", label: "Limites & Avisos", icon: Shield, group: "config" },
  { id: "messages", label: "Mensagens", icon: MessageCircle, group: "agent" },
  { id: "docs", label: "Documentos", icon: FileText, group: "agent" },
  { id: "history", label: "Histórico", icon: Clock, group: "agent" },
];
const CAT_META: Record<Cat, { title: string; sub: string }> = {
  personality: { title: "Personalidade", sub: "Quem é o agente, como fala, objetivo e o que sabe da agência." },
  channel: { title: "Canais", sub: "Por onde o agente conversa (provisionado pela agência)." },
  hours: { title: "Horário de atendimento", sub: "Quando o agente pode responder." },
  qualification: { title: "Qualificação de leads", sub: "O que perguntar para identificar um bom lead." },
  followup: { title: "Follow-up", sub: "Retomada automática de quem não respondeu." },
  scheduling: { title: "Agendamento", sub: "O que o agente faz depois de marcar a reunião." },
  knowledge: { title: "Conhecimento", sub: "Documentos e bases que o agente consulta." },
  limits: { title: "Limites & Avisos", sub: "Volume, silêncio, mídia e notificações." },
  messages: { title: "Mensagens", sub: "Conversas recentes deste agente." },
  docs: { title: "Documentos", sub: "Arquivos de apoio." },
  history: { title: "Histórico", sub: "Alterações do agente." },
};

export function AgentDetailView({ detail }: { detail: HubAgentDetail }) {
  const router = useRouter();
  const isSparkbot = detail.template_key === "sparkbot";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (detail.config ?? {}) as Record<string, any>;
  const aiModel = str(c.ai_model) || "padrão";
  const availableMods = new Set(detail.modules.map((m) => m.key));

  const [cat, setCat] = useState<Cat>("personality");
  const [status, setStatus] = useState<AgentStatus>(detail.status);
  const [enabled, setEnabled] = useState<Set<string>>(new Set(detail.modules.filter((m) => m.enabled).map((m) => m.key)));
  const [saving, setSaving] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [e, setE] = useState<Editable>(() => makeSeed(c));
  const patch = (p: Partial<Editable>) => { setE((prev) => ({ ...prev, ...p })); setDirty(true); };

  async function toggleModule(key: string, next: boolean) {
    setEnabled((prev) => { const s = new Set(prev); if (next) s.add(key); else s.delete(key); return s; });
    try {
      const res = await fetch(`/api/agent-platform/agents/${detail.id}/modules`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module_key: key, enabled: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success(next ? "Capacidade ligada" : "Capacidade desligada");
    } catch (err) {
      setEnabled((prev) => { const s = new Set(prev); if (next) s.delete(key); else s.add(key); return s; });
      toast.error("Não consegui salvar. " + (err instanceof Error ? err.message : ""));
    }
  }

  // Toggle único por capacidade: liga/desliga o módulo E (quando existe) o flag
  // de config correspondente, deixando composição + runtime coerentes.
  function masterToggle(mod: string) {
    const on = enabled.has(mod);
    toggleModule(mod, !on);
    if (mod === "active_hours") patch({ working_hours: { ...e.working_hours, enabled: !on } });
    else if (mod === "followup") patch({ follow_up_config: { ...e.follow_up_config, enabled: !on } });
  }

  async function save() {
    if (isSparkbot && !window.confirm("Isso altera a configuração do SparkBot em PRODUÇÃO. Salvar mesmo assim?")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${detail.id}/config`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personality: { name: e.identity_name, identity_mode: e.identity_mode, greeting_style: e.pers_greeting, farewell_style: e.pers_farewell, language: e.pers_language || "pt-BR", persona_description: e.persona_description },
          tone_creativity: e.tone_creativity, tone_formality: e.tone_formality, tone_naturalness: e.tone_naturalness, tone_aggressiveness: e.tone_aggressiveness,
          custom_instructions: e.custom_instructions, conversation_examples: e.conversation_examples, confirmation_mode: e.confirmation_mode, objective: e.objective,
          // flags de on/off derivados do estado do módulo (fonte única).
          working_hours: { ...e.working_hours, enabled: enabled.has("active_hours") },
          debounce_seconds: e.debounce_seconds, auto_pause_on_human_message: e.auto_pause_on_human_message,
          data_fields: e.data_fields,
          enabled_channels: channelsToDb(e.channels),
          follow_up_config: { ...e.follow_up_config, enabled: enabled.has("followup") },
          post_booking: e.post_booking,
          knowledge_base_instructions: e.knowledge_base_instructions, enabled_kbs: e.enabled_kbs,
          max_messages_per_conversation: e.max_messages_per_conversation, daily_proactive_limit: e.daily_proactive_limit, no_response_threshold: e.no_response_threshold, quiet_hours: e.quiet_hours,
          enable_audio_transcription: e.enable_audio_transcription, enable_image_analysis: e.enable_image_analysis, enable_pdf_reading: e.enable_pdf_reading, enable_summary_notes: e.enable_summary_notes,
          notifications: e.notifications,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      setDirty(false);
      toast.success("Configurações salvas");
    } catch (err) {
      toast.error("Não consegui salvar. " + (err instanceof Error ? err.message : ""));
    } finally { setSaving(false); }
  }

  function discard() { setE(makeSeed(c)); setDirty(false); }

  async function toggleStatus() {
    const next = status === "active" ? "inactive" : "active";
    setTogglingStatus(true);
    try {
      const res = await fetch(`/api/agents/${detail.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      setStatus(next === "active" ? "active" : "paused");
      toast.success(next === "active" ? "Agente ativado" : "Agente pausado");
      router.refresh();
    } catch (err) {
      toast.error("Não consegui mudar o status. " + (err instanceof Error ? err.message : ""));
    } finally { setTogglingStatus(false); }
  }

  function catVisible(id: Cat, group: "config" | "agent"): boolean {
    if (group === "agent" || ALWAYS_CATS.has(id)) return true;
    const mod = CAT_MODULE[id];
    return mod ? availableMods.has(mod) : true;
  }

  const meta = CAT_META[cat];
  const catMod = CAT_MODULE[cat];
  const hasToggle = TOGGLE_CATS.has(cat) && !!catMod;
  const moduleOn = catMod ? enabled.has(catMod) : true;

  const railItem = (id: Cat, label: string, Icon: LucideIcon) => {
    const mod = CAT_MODULE[id];
    const off = TOGGLE_CATS.has(id) && mod ? !enabled.has(mod) : false;
    return (
      <button key={id} className="cfg-rail__item" aria-current={cat === id ? "true" : undefined} onClick={() => setCat(id)} style={off ? { opacity: 0.5 } : undefined}>
        <Icon />
        <span>{label}</span>
        {off && <span className="count">off</span>}
      </button>
    );
  };

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
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 4 }}>{TEMPLATE_LABEL[detail.template_key] || detail.template_key}</div>
            <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.018em", margin: 0 }}>{detail.name}</h1>
            <div className="row wrap" style={{ gap: 16, marginTop: 8 }}>
              <StatusBadge status={status} />
              {detail.channels.map((c2) => <ChannelChip key={c2} name={c2} />)}
              <PriceBadge included={detail.included} entitled={detail.entitled} />
              {detail.since && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{detail.since}</span>}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn--ghost" onClick={() => setShowTest(true)} disabled={isSparkbot} title={isSparkbot ? "Teste o SparkBot direto no WhatsApp" : undefined}>
              <Play /> Testar
            </button>
            <button className="btn btn--ghost" onClick={toggleStatus} disabled={togglingStatus || status === "blocked"}>
              {status === "active" ? <><Pause /> Pausar</> : <><Play /> Ativar</>}
            </button>
          </div>
        </div>
      </div>

      <div className="page" style={{ maxWidth: 1120 }}>
        <div className="cfg-layout">
          {/* Rail */}
          <nav className="cfg-rail">
            <div className="cfg-rail__group">Configurações</div>
            {CATS.filter((x) => x.group === "config" && catVisible(x.id, x.group)).map((x) => railItem(x.id, x.label, x.icon))}
            <div className="cfg-rail__group">Agente</div>
            {CATS.filter((x) => x.group === "agent").map((x) => railItem(x.id, x.label, x.icon))}
          </nav>

          {/* Panel */}
          <div className="cfg-panel">
            <div className="cfg-panel__hd">
              <div>
                <div className="cfg-panel__title">{meta.title}</div>
                <div className="cfg-panel__sub">{meta.sub}</div>
              </div>
              {hasToggle && (
                <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: moduleOn ? "var(--primary)" : "var(--ink-4)" }}>{moduleOn ? "Ligado" : "Desligado"}</span>
                  <div className="switch" role="switch" aria-checked={moduleOn} onClick={() => masterToggle(catMod!)} />
                </div>
              )}
            </div>

            {hasToggle && !moduleOn ? (
              <div className="empty">
                <p style={{ marginBottom: 12 }}>Esta capacidade está desligada.</p>
                <button className="btn btn--primary btn--sm" onClick={() => masterToggle(catMod!)}>Ligar</button>
              </div>
            ) : (
              <>
                {cat === "personality" && <CatPersonality e={e} patch={patch} aiModel={aiModel} audience={detail.audience} />}
                {cat === "channel" && <CatChannel e={e} patch={patch} />}
                {cat === "hours" && <CatHours e={e} patch={patch} />}
                {cat === "qualification" && <CatQualification e={e} patch={patch} />}
                {cat === "followup" && <CatFollowup e={e} patch={patch} />}
                {cat === "scheduling" && <CatScheduling e={e} patch={patch} />}
                {cat === "knowledge" && <CatKnowledge e={e} patch={patch} />}
                {cat === "limits" && <CatLimits e={e} patch={patch} audience={detail.audience} />}
                {cat === "messages" && <div className="empty">As conversas deste agente aparecerão aqui.</div>}
                {cat === "docs" && <div className="empty">Os documentos de apoio aparecerão aqui.</div>}
                {cat === "history" && <div className="empty">O histórico de alterações aparecerá aqui.</div>}
              </>
            )}
          </div>
        </div>

        {dirty && (
          <div className="cfg-savebar">
            <span className="cfg-savebar__msg"><span className="cfg-savebar__dot" /> Você tem alterações não salvas</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn--on-dark btn--sm" onClick={discard} disabled={saving}>Descartar</button>
              <button className="btn btn--primary btn--sm" onClick={save} disabled={saving}><Check /> {saving ? "Salvando…" : "Salvar alterações"}</button>
            </div>
          </div>
        )}
      </div>

      {showTest && <TestChat agentId={detail.id} agentName={detail.name} templateKey={detail.template_key} onClose={() => setShowTest(false)} />}
    </div>
  );
}

/* ─── Helpers de form ───────────────────────────────────────────── */
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
      <div className="row between" style={{ marginBottom: 5 }}><span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span><span className="tnum" style={{ fontSize: 12, color: "var(--primary)", fontWeight: 600 }}>{value}</span></div>
      <input className="slider" type="range" min={0} max={100} value={value} onChange={(ev) => onChange(Number(ev.target.value))} />
      <div className="row between" style={{ marginTop: 4, fontSize: 11, color: "var(--ink-4)" }}><span>{left}</span><span>{right}</span></div>
    </div>
  );
}
function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return <div className="seg">{options.map((o) => <button key={o.v} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.l}</button>)}</div>;
}
function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: () => void }) {
  return (
    <div className="row between" style={{ padding: "11px 0", borderBottom: "1px solid var(--line-faint)" }}>
      <div><div style={{ fontSize: 13.5, fontWeight: 500 }}>{label}</div>{hint && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{hint}</div>}</div>
      <div className="switch" role="switch" aria-checked={checked} onClick={onChange} />
    </div>
  );
}

/* ─── Categorias ────────────────────────────────────────────────── */
function CatPersonality({ e, patch, aiModel, audience }: { e: Editable; patch: (p: Partial<Editable>) => void; aiModel: string; audience: "rep" | "lead" }) {
  const isLead = audience === "lead";
  return (
    <>
      <div className="fgrid">
        <Field label="Nome do agente" hint="Como ele se apresenta ao lead."><input className="input" value={e.identity_name} onChange={(ev) => patch({ identity_name: ev.target.value })} placeholder="Ex: Bia" /></Field>
        <Field label="Se apresenta como"><Seg value={e.identity_mode} options={[{ v: "assistant", l: "Assistente virtual" }, { v: "human", l: "Pessoa" }]} onChange={(v) => patch({ identity_mode: v })} /></Field>
      </div>
      {isLead && (
        <Field label="Objetivo do agente" hint="O que ele tenta fazer na conversa."><Seg value={e.objective} options={[{ v: "qualification_only", l: "Só qualificar" }, { v: "qualification_and_booking", l: "Qualificar + agendar" }, { v: "booking_only", l: "Só agendar" }]} onChange={(v) => patch({ objective: v })} /></Field>
      )}
      <Field label="Personalidade" hint="O jeito do agente conversar.">
        <Sld label="Criatividade" left="Conservador" right="Criativo" value={e.tone_creativity} onChange={(v) => patch({ tone_creativity: v })} />
        <Sld label="Formalidade" left="Casual" right="Formal" value={e.tone_formality} onChange={(v) => patch({ tone_formality: v })} />
        <Sld label="Naturalidade" left="Robótico" right="Humano" value={e.tone_naturalness} onChange={(v) => patch({ tone_naturalness: v })} />
        <Sld label="Assertividade" left="Tímido" right="Direto" value={e.tone_aggressiveness} onChange={(v) => patch({ tone_aggressiveness: v })} />
      </Field>
      <Field label="Instruções customizadas" hint="O que ele precisa saber sobre a agência e como agir."><textarea className="textarea" rows={5} maxLength={10000} value={e.custom_instructions} onChange={(ev) => patch({ custom_instructions: ev.target.value })} placeholder="Ex: Você é a assistente da Pereira Seguros, foco em planos de saúde para famílias na Flórida." /></Field>
      <Field label="Exemplos de conversa" hint="Como responder em situações comuns (opcional)."><textarea className="textarea" rows={4} maxLength={20000} value={e.conversation_examples} onChange={(ev) => patch({ conversation_examples: ev.target.value })} placeholder="Ex: quando perguntam preço, responda que depende do perfil e ofereça uma ligação rápida." /></Field>
      {!isLead && (
        <Field label="Quando pedir confirmação" hint="Antes de agir no Spark Leads.">
          <div className="col" style={{ gap: 8 }}>
            {([["always", "Sempre — antes de qualquer ação"], ["medium_and_high", "Em ações importantes (recomendado)"], ["high_only", "Só nas mais sensíveis"]] as [ConfMode, string][]).map(([v, l]) => (
              <label key={v} className="row" style={{ gap: 10, fontSize: 13.5, cursor: "pointer" }}><input type="radio" name="conf" checked={e.confirmation_mode === v} onChange={() => patch({ confirmation_mode: v })} /> <span>{l}</span></label>
            ))}
          </div>
        </Field>
      )}
      <Field label="Espera antes de responder" hint="Segundos — agrupa mensagens enviadas em sequência."><input className="input" type="number" min={5} max={60} value={e.debounce_seconds} onChange={(ev) => patch({ debounce_seconds: Number(ev.target.value) })} style={{ width: 110 }} /></Field>
      <Toggle label="Pausar quando um humano responder" hint="Se você entrar na conversa, o agente para." checked={e.auto_pause_on_human_message} onChange={() => patch({ auto_pause_on_human_message: !e.auto_pause_on_human_message })} />
      <Field label="Modelo de IA"><span className="pill pill--muted">{aiModel}</span><span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>gerenciado pelo Spark</span></Field>
    </>
  );
}

function CatChannel({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const OPTS: { k: ChannelKey; hint: string }[] = [
    { k: "whatsapp_web", hint: "Número de WhatsApp conectado via Stevo (o mais comum)." },
    { k: "whatsapp_api", hint: "WhatsApp oficial pela API da Meta." },
    { k: "instagram", hint: "Mensagens diretas do Instagram." },
  ];
  const toggle = (k: ChannelKey) =>
    patch({ channels: e.channels.includes(k) ? e.channels.filter((x) => x !== k) : [...e.channels, k] });
  return (
    <Field label="Canais que o agente usa" hint="Por onde ele conversa. O canal precisa estar conectado pela agência pra funcionar.">
      <div className="col" style={{ gap: 8 }}>
        {OPTS.map((o) => (
          <label
            key={o.k}
            className="row between"
            style={{ gap: 10, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "var(--r-md)", cursor: "pointer" }}
          >
            <div className="row" style={{ gap: 10 }}>
              <ChannelChip name={o.k} />
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{o.hint}</span>
            </div>
            <div className="switch" role="switch" aria-checked={e.channels.includes(o.k)} onClick={() => toggle(o.k)} />
          </label>
        ))}
      </div>
    </Field>
  );
}

function CatHours({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const w = e.working_hours;
  const setW = (p: Partial<WorkingHoursConfig>) => patch({ working_hours: { ...w, ...p } });
  return (
    <div className="fgrid">
      <Field label="Fuso horário"><input className="input" value={w.timezone} onChange={(ev) => setW({ timezone: ev.target.value })} placeholder="America/New_York" /></Field>
      <Field label="Aplicar como"><Seg value={w.mode} options={[{ v: "only_during", l: "No horário" }, { v: "only_outside", l: "Fora dele" }]} onChange={(v) => setW({ mode: v })} /></Field>
    </div>
  );
}

function CatQualification({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const fields = e.data_fields;
  const update = (i: number, p: Partial<DataField>) => patch({ data_fields: fields.map((f, idx) => (idx === i ? { ...f, ...p } : f)) });
  const add = () => patch({ data_fields: [...fields, { key: `campo_${fields.length + 1}`, label: "Nova pergunta", required: false, type: "text" }] });
  const remove = (i: number) => patch({ data_fields: fields.filter((_, idx) => idx !== i) });
  return (
    <div className="col" style={{ gap: 8 }}>
      {fields.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nenhuma pergunta configurada.</div>}
      {fields.map((f, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 130px auto auto", gap: 10, alignItems: "center", background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8 }}>
          <input className="input" value={f.label} onChange={(ev) => update(i, { label: ev.target.value })} />
          <select className="select" value={f.type} onChange={(ev) => update(i, { type: ev.target.value as DataField["type"] })}><option value="text">Texto</option><option value="date">Data</option><option value="boolean">Sim/Não</option><option value="select">Opções</option></select>
          <label className="row" style={{ gap: 6, fontSize: 12, color: "var(--ink-3)" }}><div className="switch" role="switch" aria-checked={f.required} onClick={() => update(i, { required: !f.required })} /> obrig.</label>
          <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remove(i)} aria-label="Remover"><Trash2 size={13} /></button>
        </div>
      ))}
      <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start", marginTop: 2 }} onClick={add}><Plus /> Nova pergunta</button>
    </div>
  );
}

function CatFollowup({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const f = e.follow_up_config;
  const set = (p: Partial<FollowUpConfig>) => patch({ follow_up_config: { ...f, ...p } });
  return (
    <>
      <Field label="Como decidir as mensagens"><Seg value={f.mode} options={[{ v: "ai_auto", l: "IA decide" }, { v: "manual", l: "Passos fixos" }]} onChange={(v) => set({ mode: v })} /></Field>
      <div className="fgrid">
        {f.mode === "ai_auto" && <Field label="Intensidade" hint="1 leve · 10 insistente."><input className="input" type="number" min={1} max={10} value={f.intensity} onChange={(ev) => set({ intensity: Number(ev.target.value) })} style={{ width: 100 }} /></Field>}
        <Field label="Máximo de tentativas"><input className="input" type="number" min={1} max={20} value={f.max_attempts} onChange={(ev) => set({ max_attempts: Number(ev.target.value) })} style={{ width: 100 }} /></Field>
      </div>
    </>
  );
}

function CatScheduling({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const pb = e.post_booking;
  const set = (p: Partial<PostBooking>) => patch({ post_booking: { ...pb, ...p } });
  return (
    <>
      <Field label="Calendário"><span className="muted" style={{ fontSize: 13 }}>Conectado pela agência (Spark Leads). A escolha de calendário entra em breve aqui.</span></Field>
      <Field label="Depois de agendar"><Seg value={pb.behavior} options={[{ v: "stop_and_handoff", l: "Passar pra humano" }, { v: "continue_until_appointment", l: "Continuar até a reunião" }]} onChange={(v) => set({ behavior: v })} /></Field>
      <Field label="Mensagem ao passar pra humano"><textarea className="textarea" rows={2} value={pb.handoff_message} onChange={(ev) => set({ handoff_message: ev.target.value })} placeholder="Ex: Perfeito! Já agendei. Um especialista vai te acompanhar a partir daqui." /></Field>
      <Toggle label="Permitir reagendamento" checked={pb.allow_reschedule} onChange={() => set({ allow_reschedule: !pb.allow_reschedule })} />
    </>
  );
}

function CatKnowledge({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const KBS: { v: string; l: string }[] = [{ v: "national_life_group", l: "National Life Group" }, { v: "agency_brazillionaires", l: "Brazillionaires" }];
  const toggleKb = (v: string) => patch({ enabled_kbs: e.enabled_kbs.includes(v) ? e.enabled_kbs.filter((k) => k !== v) : [...e.enabled_kbs, v] });
  return (
    <>
      <Field label="Bases de conhecimento" hint="O agente consulta antes de responder.">
        <div className="col" style={{ gap: 10 }}>{KBS.map((kb) => <label key={kb.v} className="row" style={{ gap: 10, fontSize: 13.5, cursor: "pointer" }}><div className="switch" role="switch" aria-checked={e.enabled_kbs.includes(kb.v)} onClick={() => toggleKb(kb.v)} /> {kb.l}</label>)}</div>
      </Field>
      <Field label="Instruções de uso" hint="Como usar os documentos."><textarea className="textarea" rows={3} maxLength={10000} value={e.knowledge_base_instructions} onChange={(ev) => patch({ knowledge_base_instructions: ev.target.value })} placeholder="Ex: Use a tabela de preços só para planos família. Não cite valores sem confirmar o estado." /></Field>
    </>
  );
}

function CatLimits({ e, patch, audience }: { e: Editable; patch: (p: Partial<Editable>) => void; audience: "rep" | "lead" }) {
  const isRep = audience === "rep";
  const q = e.quiet_hours;
  const setQ = (p: Partial<Quiet>) => patch({ quiet_hours: { ...q, ...p } });
  const nt = e.notifications;
  const setN = (p: Partial<Notif>) => patch({ notifications: { ...nt, ...p } });
  return (
    <>
      <div className="fgrid">
        <Field label="Máx. mensagens por conversa"><input className="input" type="number" min={10} max={200} value={e.max_messages_per_conversation} onChange={(ev) => patch({ max_messages_per_conversation: Number(ev.target.value) })} style={{ width: 110 }} /></Field>
        {isRep && <Field label="Proativos por dia" hint="Quantas vezes inicia conversa."><input className="input" type="number" min={0} max={100} value={e.daily_proactive_limit} onChange={(ev) => patch({ daily_proactive_limit: Number(ev.target.value) })} style={{ width: 110 }} /></Field>}
      </div>
      {isRep && (
        <Field label="Horário de silêncio" hint="Não envia nesse intervalo.">
          <div className="row" style={{ gap: 8 }}>
            <div className="switch" role="switch" aria-checked={q.enabled} onClick={() => setQ({ enabled: !q.enabled })} />
            {q.enabled && <><input className="input" value={q.start} onChange={(ev) => setQ({ start: ev.target.value })} style={{ width: 90 }} /><span className="muted">até</span><input className="input" value={q.end} onChange={(ev) => setQ({ end: ev.target.value })} style={{ width: 90 }} /></>}
          </div>
        </Field>
      )}
      <div style={{ marginTop: 6 }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Mídia</div>
        <Toggle label="Transcrever áudios" checked={e.enable_audio_transcription} onChange={() => patch({ enable_audio_transcription: !e.enable_audio_transcription })} />
        <Toggle label="Analisar imagens" checked={e.enable_image_analysis} onChange={() => patch({ enable_image_analysis: !e.enable_image_analysis })} />
        <Toggle label="Ler PDFs" checked={e.enable_pdf_reading} onChange={() => patch({ enable_pdf_reading: !e.enable_pdf_reading })} />
        <Toggle label="Resumo automático em nota" checked={e.enable_summary_notes} onChange={() => patch({ enable_summary_notes: !e.enable_summary_notes })} />
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="eyebrow" style={{ marginBottom: 4 }}>Avisos por email</div>
        <Toggle label="Lead qualificado" checked={nt.on_qualified} onChange={() => setN({ on_qualified: !nt.on_qualified })} />
        <Toggle label="Reunião agendada" checked={nt.on_booked} onChange={() => setN({ on_booked: !nt.on_booked })} />
        <Toggle label="Passou pra humano" checked={nt.on_handed_off} onChange={() => setN({ on_handed_off: !nt.on_handed_off })} />
        <Field label="Email para avisos"><input className="input" type="email" value={nt.notification_email} onChange={(ev) => setN({ notification_email: ev.target.value })} placeholder="voce@agencia.com" style={{ maxWidth: 320 }} /></Field>
      </div>
    </>
  );
}
