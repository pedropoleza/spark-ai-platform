"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft, Play, Pause, Check, Plus, Trash2,
  Sparkles, Clock, Calendar, MessageCircle, Users, Send, FileText, Shield, Zap,
  Wand2, Workflow, PauseCircle,
  type LucideIcon,
} from "lucide-react";
import { AMark, StatusBadge, ChannelChip, PriceBadge } from "@/components/hub/primitives";
import { TestChat } from "./test-chat";
import { KbManager } from "./kb-manager";
import type { HubAgentDetail } from "@/lib/hub/data";
import type { AgentStatus, ChannelKey } from "@/components/hub/types";
import { channelsFromDb, channelsToDb, nonUiChannels } from "@/components/hub/types";
import type {
  DataField, FollowUpConfig, WorkingHoursConfig, WorkingHoursDay,
  TargetingRule, AutomationRule, AutomationAction, DeactivationRule, HandoffMessage,
} from "@/types/agent";

const TEMPLATE_LABEL: Record<string, string> = { sparkbot: "SparkBot", sales: "Vendas", recruitment: "Recrutamento", custom: "Personalizado" };

type ConfMode = "always" | "medium_and_high" | "high_only";
type Objective = "qualification_only" | "qualification_and_booking" | "booking_only";
type Cat =
  | "identity" | "tone"
  | "channel" | "qualification" | "scheduling" | "followup" | "outreach" | "knowledge"
  | "hours" | "automations" | "pause" | "limits";

const num = (v: unknown, d: number) => (typeof v === "number" && !isNaN(v) ? v : d);
// Clamp pra faixa do schema — legado fora da faixa derrubava o PUT inteiro (400).
const clampNum = (v: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, num(v, d)));
const str = (v: unknown) => (typeof v === "string" ? v : "");
const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);
const rid = () => Math.random().toString(36).slice(2, 10);

interface Quiet { enabled: boolean; start: string; end: string; timezone?: string; days?: number[] }
interface PostBooking { behavior: "stop_and_handoff" | "continue_until_appointment"; handoff_message: string; allow_reschedule: boolean }
interface Notif { on_qualified: boolean; on_booked: boolean; on_handed_off: boolean; on_error: boolean; notification_email: string }
interface Outreach { tag_filter: { tags: string[]; match: "any" | "all" }; rate_per_hour: number; daily_cap: number; respect_working_hours: boolean; opening_message: string }

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
  targeting_rules: TargetingRule[];
  channels: ChannelKey[];
  extra_channels: string[]; // canais do DB que o /hub não edita (ex: Email) — preservados
  follow_up_config: FollowUpConfig;
  post_booking: PostBooking;
  specialist_name: string;
  preferred_time_slot: string;
  check_legal_docs: boolean;
  handoff_messages: HandoffMessage[];
  automations: AutomationRule[];
  deactivation_rules: DeactivationRule[];
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
  outreach: Outreach;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSeed(c: Record<string, any>): Editable {
  const p = (c.personality ?? {}) as Record<string, unknown>;
  const fu = (c.follow_up_config ?? {}) as Partial<FollowUpConfig>;
  const wh = (c.working_hours ?? {}) as Partial<WorkingHoursConfig>;
  const pb = (c.post_booking ?? {}) as Partial<PostBooking>;
  const qh = (c.quiet_hours ?? {}) as Partial<Quiet>;
  const nt = (c.notifications ?? {}) as Partial<Notif>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = (c.outreach_config ?? {}) as Record<string, any>;
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
    debounce_seconds: clampNum(c.debounce_seconds, 5, 60, 10),
    auto_pause_on_human_message: bool(c.auto_pause_on_human_message, true),
    data_fields: Array.isArray(c.data_fields) ? (c.data_fields as DataField[]) : [],
    targeting_rules: Array.isArray(c.targeting_rules) ? (c.targeting_rules as TargetingRule[]) : [],
    channels: channelsFromDb(c.enabled_channels),
    extra_channels: nonUiChannels(c.enabled_channels),
    follow_up_config: {
      enabled: bool(fu.enabled), mode: fu.mode === "manual" ? "manual" : "ai_auto",
      intensity: clampNum(fu.intensity, 1, 10, 5), max_attempts: clampNum(fu.max_attempts, 1, 20, 3),
      min_delay_minutes: num(fu.min_delay_minutes, 10), max_delay_minutes: num(fu.max_delay_minutes, 10080),
      custom_prompt: str(fu.custom_prompt), manual_steps: Array.isArray(fu.manual_steps) ? fu.manual_steps : [],
    },
    post_booking: { behavior: pb.behavior === "continue_until_appointment" ? "continue_until_appointment" : "stop_and_handoff", handoff_message: str(pb.handoff_message), allow_reschedule: bool(pb.allow_reschedule, true) },
    specialist_name: str(c.specialist_name),
    preferred_time_slot: str(c.preferred_time_slot),
    check_legal_docs: bool(c.check_legal_docs),
    handoff_messages: Array.isArray(c.handoff_messages) ? (c.handoff_messages as HandoffMessage[]) : [],
    automations: Array.isArray(c.automations) ? (c.automations as AutomationRule[]) : [],
    deactivation_rules: Array.isArray(c.deactivation_rules) ? (c.deactivation_rules as DeactivationRule[]) : [],
    knowledge_base_instructions: str(c.knowledge_base_instructions),
    enabled_kbs: Array.isArray(c.enabled_kbs) ? (c.enabled_kbs as string[]) : [],
    max_messages_per_conversation: clampNum(c.max_messages_per_conversation, 10, 200, 100),
    daily_proactive_limit: clampNum(c.daily_proactive_limit, 0, 100, 10),
    no_response_threshold: clampNum(c.no_response_threshold, 1, 20, 3),
    quiet_hours: { enabled: bool(qh.enabled), start: str(qh.start) || "21:00", end: str(qh.end) || "08:00", timezone: qh.timezone, days: qh.days },
    enable_audio_transcription: bool(c.enable_audio_transcription, true),
    enable_image_analysis: bool(c.enable_image_analysis, true),
    enable_pdf_reading: bool(c.enable_pdf_reading, true),
    enable_summary_notes: bool(c.enable_summary_notes, false),
    notifications: { on_qualified: bool(nt.on_qualified, true), on_booked: bool(nt.on_booked, true), on_handed_off: bool(nt.on_handed_off, false), on_error: bool(nt.on_error, true), notification_email: str(nt.notification_email) },
    outreach: {
      tag_filter: { tags: Array.isArray(oc.tag_filter?.tags) ? (oc.tag_filter.tags as string[]) : [], match: oc.tag_filter?.match === "all" ? "all" : "any" },
      rate_per_hour: num(oc.rate_per_hour, 20),
      daily_cap: num(oc.daily_cap, 100),
      respect_working_hours: bool(oc.respect_working_hours, true),
      opening_message: str(oc.opening_message),
    },
  };
}

// Categoria → módulo do catálogo (visibilidade + toggle mestre).
const CAT_MODULE: Partial<Record<Cat, string>> = {
  channel: "channel", qualification: "qualification", scheduling: "scheduling",
  followup: "followup", outreach: "outreach", knowledge: "knowledge", hours: "active_hours",
};
// Categorias com toggle mestre (ligar/desligar a capacidade). As demais são sempre-on.
const TOGGLE_CATS = new Set<Cat>(["qualification", "scheduling", "followup", "outreach", "knowledge", "hours"]);
// Só fazem sentido para agentes que falam com LEADS (não pro SparkBot do rep).
const LEAD_ONLY = new Set<Cat>(["channel", "qualification", "scheduling", "followup", "outreach", "automations"]);

const GROUPS: { id: string; label: string }[] = [
  { id: "comportamento", label: "Comportamento" },
  { id: "capacidades", label: "Capacidades" },
  { id: "operacao", label: "Operação" },
];
const CATS: { id: Cat; label: string; icon: LucideIcon; group: string }[] = [
  { id: "identity", label: "Identidade", icon: Sparkles, group: "comportamento" },
  { id: "tone", label: "Tom & estilo", icon: Wand2, group: "comportamento" },
  { id: "channel", label: "Canais", icon: MessageCircle, group: "capacidades" },
  { id: "qualification", label: "Qualificação", icon: Users, group: "capacidades" },
  { id: "scheduling", label: "Agendamento", icon: Calendar, group: "capacidades" },
  { id: "followup", label: "Follow-up", icon: Send, group: "capacidades" },
  { id: "outreach", label: "Prospecção", icon: Zap, group: "capacidades" },
  { id: "knowledge", label: "Conhecimento", icon: FileText, group: "capacidades" },
  { id: "hours", label: "Atendimento", icon: Clock, group: "operacao" },
  { id: "automations", label: "Automações", icon: Workflow, group: "operacao" },
  { id: "pause", label: "Pausa do bot", icon: PauseCircle, group: "operacao" },
  { id: "limits", label: "Limites & avisos", icon: Shield, group: "operacao" },
];
const CAT_META: Record<Cat, { title: string; sub: string }> = {
  identity: { title: "Identidade", sub: "Quem é o agente, como se apresenta e o que sabe da agência." },
  tone: { title: "Tom & estilo", sub: "O jeito de conversar e exemplos de resposta." },
  channel: { title: "Canais", sub: "Por onde o agente conversa (conectado pela agência)." },
  qualification: { title: "Qualificação de leads", sub: "O que perguntar e quais contatos atender." },
  scheduling: { title: "Agendamento", sub: "Como o agente marca e o que faz depois." },
  followup: { title: "Follow-up", sub: "Retomada automática de quem não respondeu." },
  outreach: { title: "Prospecção", sub: "O agente inicia conversas com uma lista (por tag), no ritmo certo." },
  knowledge: { title: "Conhecimento", sub: "Documentos e bases que o agente consulta." },
  hours: { title: "Horário de atendimento", sub: "Quando o agente pode responder." },
  automations: { title: "Automações", sub: "Ações automáticas quando algo acontece na conversa." },
  pause: { title: "Pausa do bot", sub: "Quando o agente para e devolve a conversa pra uma pessoa." },
  limits: { title: "Limites & avisos", sub: "Volume, confirmações, silêncio, mídia e notificações." },
};

export function AgentDetailView({ detail }: { detail: HubAgentDetail }) {
  const router = useRouter();
  const isSparkbot = detail.template_key === "sparkbot";
  const isLead = detail.audience === "lead";
  const isRecruitment = detail.template_key === "recruitment";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (detail.config ?? {}) as Record<string, any>;
  const aiModel = str(c.ai_model) || "padrão";
  const availableMods = new Set(detail.modules.map((m) => m.key));

  const [cat, setCat] = useState<Cat>("identity");
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
    else if (mod === "outreach") patch({ outreach: { ...e.outreach } }); // marca dirty; enabled deriva no save
  }

  async function save() {
    if (isSparkbot && !window.confirm("Isso altera a configuração do SparkBot em PRODUÇÃO. Salvar mesmo assim?")) return;
    setSaving(true);
    try {
      // Filtra entradas incompletas pra não falhar a validação do PUT inteiro.
      const cleanTargeting = e.targeting_rules.filter((t) => t.tag || t.custom_field_key || t.pipeline_stage_id);
      const cleanHandoff = e.handoff_messages.filter((h) => h.label.trim() && h.text.trim());
      const cleanDeact = e.deactivation_rules.filter((d) => d.tag || d.field_key);
      const cleanAutos = e.automations.filter((a) => a.actions.length > 0);
      const res = await fetch(`/api/agents/${detail.id}/config`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personality: { name: e.identity_name, identity_mode: e.identity_mode, greeting_style: e.pers_greeting, farewell_style: e.pers_farewell, language: e.pers_language || "pt-BR", persona_description: e.persona_description },
          tone_creativity: e.tone_creativity, tone_formality: e.tone_formality, tone_naturalness: e.tone_naturalness, tone_aggressiveness: e.tone_aggressiveness,
          custom_instructions: e.custom_instructions, conversation_examples: e.conversation_examples, confirmation_mode: e.confirmation_mode, objective: e.objective,
          // flags de on/off derivados do estado do módulo (fonte única).
          working_hours: { ...e.working_hours, enabled: enabled.has("active_hours") },
          debounce_seconds: e.debounce_seconds, auto_pause_on_human_message: e.auto_pause_on_human_message,
          data_fields: e.data_fields, targeting_rules: cleanTargeting,
          enabled_channels: [...channelsToDb(e.channels), ...e.extra_channels],
          follow_up_config: { ...e.follow_up_config, enabled: enabled.has("followup") },
          post_booking: e.post_booking,
          specialist_name: e.specialist_name, preferred_time_slot: e.preferred_time_slot, check_legal_docs: e.check_legal_docs,
          handoff_messages: cleanHandoff, automations: cleanAutos, deactivation_rules: cleanDeact,
          knowledge_base_instructions: e.knowledge_base_instructions, enabled_kbs: e.enabled_kbs,
          max_messages_per_conversation: e.max_messages_per_conversation, daily_proactive_limit: e.daily_proactive_limit, no_response_threshold: e.no_response_threshold, quiet_hours: e.quiet_hours,
          enable_audio_transcription: e.enable_audio_transcription, enable_image_analysis: e.enable_image_analysis, enable_pdf_reading: e.enable_pdf_reading, enable_summary_notes: e.enable_summary_notes,
          notifications: e.notifications,
          outreach_config: { ...e.outreach, enabled: enabled.has("outreach") },
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

  function catVisible(id: Cat): boolean {
    // Sempre: identidade, tom, pausa, limites.
    if (id === "identity" || id === "tone" || id === "pause" || id === "limits") return true;
    // Lead: TODAS as capacidades aparecem. As com toggle mestre nascem em "off"
    // se o módulo não está anexado — clicar em Ligar faz upsert da instance.
    // (Sem isso: chicken-and-egg — a aba some por estar off, e você não chega no toggle.)
    if (isLead) return true;
    // Rep (SparkBot): só o que ele realmente tem. Esconde capacidades de lead.
    if (LEAD_ONLY.has(id)) return false;
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
      <button key={id} className="cfg-rail__item" aria-current={cat === id ? "true" : undefined} onClick={() => setCat(id)} style={off ? { opacity: 0.55 } : undefined}>
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
            {GROUPS.map((g) => {
              const items = CATS.filter((x) => x.group === g.id && catVisible(x.id));
              if (items.length === 0) return null;
              return (
                <div key={g.id}>
                  <div className="cfg-rail__group">{g.label}</div>
                  {items.map((x) => railItem(x.id, x.label, x.icon))}
                </div>
              );
            })}
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
                {cat === "identity" && <CatIdentity e={e} patch={patch} isLead={isLead} />}
                {cat === "tone" && <CatTone e={e} patch={patch} aiModel={aiModel} />}
                {cat === "channel" && <CatChannel e={e} patch={patch} />}
                {cat === "qualification" && <CatQualification e={e} patch={patch} />}
                {cat === "scheduling" && <CatScheduling e={e} patch={patch} isRecruitment={isRecruitment} />}
                {cat === "followup" && <CatFollowup e={e} patch={patch} />}
                {cat === "outreach" && <CatOutreach e={e} patch={patch} />}
                {cat === "knowledge" && <CatKnowledge e={e} patch={patch} agentId={detail.id} />}
                {cat === "hours" && <CatHours e={e} patch={patch} />}
                {cat === "automations" && <CatAutomations e={e} patch={patch} />}
                {cat === "pause" && <CatPause e={e} patch={patch} />}
                {cat === "limits" && <CatLimits e={e} patch={patch} isRep={!isLead} />}
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
function SubHd({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow" style={{ marginTop: 18, marginBottom: 2, paddingTop: 14, borderTop: "1px solid var(--line-faint)" }}>{children}</div>;
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

/* ─── Identidade ────────────────────────────────────────────────── */
function CatIdentity({ e, patch, isLead }: { e: Editable; patch: (p: Partial<Editable>) => void; isLead: boolean }) {
  return (
    <>
      <div className="fgrid">
        <Field label="Nome do agente" hint="Como ele se apresenta."><input className="input" value={e.identity_name} onChange={(ev) => patch({ identity_name: ev.target.value })} placeholder="Ex: Bia" /></Field>
        <Field label="Se apresenta como"><Seg value={e.identity_mode} options={[{ v: "assistant", l: "Assistente virtual" }, { v: "human", l: "Pessoa" }]} onChange={(v) => patch({ identity_mode: v })} /></Field>
      </div>
      {isLead && (
        <Field label="Objetivo do agente" hint="O que ele tenta fazer na conversa."><Seg value={e.objective} options={[{ v: "qualification_only", l: "Só qualificar" }, { v: "qualification_and_booking", l: "Qualificar + agendar" }, { v: "booking_only", l: "Só agendar" }]} onChange={(v) => patch({ objective: v })} /></Field>
      )}
      <Field label="Sobre a agência e como agir" hint="O contexto principal — quem é a empresa, o que oferece, como o agente deve se portar."><textarea className="textarea" rows={5} maxLength={10000} value={e.custom_instructions} onChange={(ev) => patch({ custom_instructions: ev.target.value })} placeholder="Ex: Você é a assistente da Pereira Seguros, foco em planos de saúde para famílias na Flórida." /></Field>
      <SubHd>Saudação & despedida</SubHd>
      <div className="fgrid">
        <Field label="Como cumprimenta" hint="A primeira fala."><input className="input" value={e.pers_greeting} onChange={(ev) => patch({ pers_greeting: ev.target.value })} placeholder="Ex: Oi {name}, tudo bem?" /></Field>
        <Field label="Como se despede"><input className="input" value={e.pers_farewell} onChange={(ev) => patch({ pers_farewell: ev.target.value })} placeholder="Ex: Qualquer coisa, é só chamar!" /></Field>
      </div>
      <Field label="Descrição da personalidade" hint="Em poucas linhas, o jeitão do agente (opcional)."><textarea className="textarea" rows={3} maxLength={2000} value={e.persona_description} onChange={(ev) => patch({ persona_description: ev.target.value })} placeholder="Ex: Calorosa, objetiva e atenciosa. Fala como uma consultora experiente, sem enrolação." /></Field>
    </>
  );
}

/* ─── Tom & estilo ──────────────────────────────────────────────── */
function CatTone({ e, patch, aiModel }: { e: Editable; patch: (p: Partial<Editable>) => void; aiModel: string }) {
  return (
    <>
      <Field label="Personalidade" hint="Onde o agente fica em cada eixo.">
        <Sld label="Criatividade" left="Conservador" right="Criativo" value={e.tone_creativity} onChange={(v) => patch({ tone_creativity: v })} />
        <Sld label="Formalidade" left="Casual" right="Formal" value={e.tone_formality} onChange={(v) => patch({ tone_formality: v })} />
        <Sld label="Naturalidade" left="Robótico" right="Humano" value={e.tone_naturalness} onChange={(v) => patch({ tone_naturalness: v })} />
        <Sld label="Assertividade" left="Tímido" right="Direto" value={e.tone_aggressiveness} onChange={(v) => patch({ tone_aggressiveness: v })} />
      </Field>
      <Field label="Exemplos de conversa" hint="Como responder em situações comuns (opcional, mas ajuda muito)."><textarea className="textarea" rows={5} maxLength={20000} value={e.conversation_examples} onChange={(ev) => patch({ conversation_examples: ev.target.value })} placeholder={"Ex:\nLead: Quanto custa?\nAgente: Depende do perfil — me conta sua idade e cidade que eu já te dou uma ideia 😊"} /></Field>
      <Field label="Modelo de IA"><span className="pill pill--muted">{aiModel}</span><span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>gerenciado pelo Spark</span></Field>
    </>
  );
}

/* ─── Canais ────────────────────────────────────────────────────── */
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
          <label key={o.k} className="row between" style={{ gap: 10, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "var(--r-md)", cursor: "pointer" }}>
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

/* ─── Atendimento (horário) ─────────────────────────────────────── */
const WEEK: { key: string; label: string; util: boolean }[] = [
  { key: "monday", label: "Segunda", util: true }, { key: "tuesday", label: "Terça", util: true },
  { key: "wednesday", label: "Quarta", util: true }, { key: "thursday", label: "Quinta", util: true },
  { key: "friday", label: "Sexta", util: true }, { key: "saturday", label: "Sábado", util: false },
  { key: "sunday", label: "Domingo", util: false },
];
function CatHours({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const w = e.working_hours;
  const setW = (p: Partial<WorkingHoursConfig>) => patch({ working_hours: { ...w, ...p } });
  const setDay = (key: string, p: Partial<WorkingHoursDay>) => {
    const cur: WorkingHoursDay = w.schedule[key] || { enabled: false, start: "09:00", end: "17:00" };
    setW({ schedule: { ...w.schedule, [key]: { ...cur, ...p } } });
  };
  const preset = () => {
    const s: Record<string, WorkingHoursDay> = {};
    for (const d of WEEK) s[d.key] = { enabled: d.util, start: "09:00", end: "18:00" };
    setW({ schedule: s });
  };
  const anyDay = WEEK.some((d) => w.schedule[d.key]?.enabled);
  return (
    <>
      <div className="fgrid">
        <Field label="Fuso horário"><input className="input" value={w.timezone} onChange={(ev) => setW({ timezone: ev.target.value })} placeholder="America/New_York" /></Field>
        <Field label="Aplicar como" hint="Responder dentro ou fora do horário."><Seg value={w.mode} options={[{ v: "only_during", l: "No horário" }, { v: "only_outside", l: "Fora dele" }]} onChange={(v) => setW({ mode: v })} /></Field>
      </div>
      <Field label="Horário por dia" hint="Defina os dias e faixas em que o agente atende.">
        <button className="btn btn--ghost btn--sm" style={{ marginBottom: 10 }} onClick={preset}>Preencher seg–sex, 9h–18h</button>
        <div className="col" style={{ gap: 6 }}>
          {WEEK.map((d) => {
            const day: WorkingHoursDay = w.schedule[d.key] || { enabled: false, start: "09:00", end: "17:00" };
            return (
              <div key={d.key} className="row" style={{ gap: 10, alignItems: "center", opacity: day.enabled ? 1 : 0.6 }}>
                <div className="switch" role="switch" aria-checked={day.enabled} onClick={() => setDay(d.key, { enabled: !day.enabled })} />
                <span style={{ width: 78, fontSize: 13, fontWeight: 500 }}>{d.label}</span>
                <input className="input" type="time" value={day.start} disabled={!day.enabled} onChange={(ev) => setDay(d.key, { start: ev.target.value })} style={{ width: 120 }} />
                <span className="muted" style={{ fontSize: 12 }}>às</span>
                <input className="input" type="time" value={day.end} disabled={!day.enabled} onChange={(ev) => setDay(d.key, { end: ev.target.value })} style={{ width: 120 }} />
              </div>
            );
          })}
        </div>
        {w.mode === "only_during" && !anyDay && (
          <div className="card card--flat" style={{ padding: 10, marginTop: 10, background: "var(--warn-soft, var(--surface-2))" }}>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              Nenhum dia ativo com modo <strong>“No horário”</strong> = o agente não responde nunca. Ative ao menos um dia (ou use o botão acima).
            </span>
          </div>
        )}
      </Field>
    </>
  );
}

/* ─── Qualificação + targeting ──────────────────────────────────── */
function CatQualification({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const fields = e.data_fields;
  const update = (i: number, p: Partial<DataField>) => patch({ data_fields: fields.map((f, idx) => (idx === i ? { ...f, ...p } : f)) });
  const add = () => patch({ data_fields: [...fields, { key: `campo_${fields.length + 1}`, label: "Nova pergunta", required: false, type: "text" }] });
  const remove = (i: number) => patch({ data_fields: fields.filter((_, idx) => idx !== i) });

  const tr = e.targeting_rules;
  const addT = () => patch({ targeting_rules: [...tr, { id: rid(), type: "tag", tag: "" }] });
  const updT = (i: number, p: Partial<TargetingRule>) => patch({ targeting_rules: tr.map((r, idx) => (idx === i ? { ...r, ...p } : r)) });
  const remT = (i: number) => patch({ targeting_rules: tr.filter((_, idx) => idx !== i) });

  return (
    <>
      <Field label="Perguntas de qualificação" hint="O que o agente coleta para identificar um bom lead.">
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
      </Field>

      <SubHd>Quem o agente atende</SubHd>
      <Field label="Filtros de público" hint="Restringe a quais contatos o agente responde. Vazio = sem restrição.">
        <div className="col" style={{ gap: 8 }}>
          {tr.map((r, i) => (
            <div key={r.id} className="row" style={{ gap: 8, alignItems: "center", background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8, flexWrap: "wrap" }}>
              <select className="select" value={r.type} onChange={(ev) => updT(i, { type: ev.target.value as TargetingRule["type"] })} style={{ width: 170 }}>
                <option value="tag">Tem a tag</option>
                <option value="custom_field">Campo personalizado</option>
                <option value="pipeline_stage">Etapa do funil</option>
              </select>
              {r.type === "tag" && <input className="input grow" value={r.tag || ""} onChange={(ev) => updT(i, { tag: ev.target.value })} placeholder="nome da tag" />}
              {r.type === "custom_field" && (<>
                <input className="input" value={r.custom_field_key || ""} onChange={(ev) => updT(i, { custom_field_key: ev.target.value })} placeholder="chave do campo" style={{ width: 160 }} />
                <input className="input grow" value={r.custom_field_value || ""} onChange={(ev) => updT(i, { custom_field_value: ev.target.value })} placeholder="valor" />
              </>)}
              {r.type === "pipeline_stage" && (<>
                <input className="input" value={r.pipeline_id || ""} onChange={(ev) => updT(i, { pipeline_id: ev.target.value })} placeholder="ID do funil" style={{ width: 160 }} />
                <input className="input grow" value={r.pipeline_stage_id || ""} onChange={(ev) => updT(i, { pipeline_stage_id: ev.target.value })} placeholder="ID da etapa" />
              </>)}
              <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remT(i)} aria-label="Remover"><Trash2 size={13} /></button>
            </div>
          ))}
          <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={addT}><Plus /> Novo filtro</button>
        </div>
      </Field>
    </>
  );
}

/* ─── Follow-up ─────────────────────────────────────────────────── */
function DelayInput({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const unit = minutes >= 1440 && minutes % 1440 === 0 ? "d" : minutes >= 60 && minutes % 60 === 0 ? "h" : "m";
  const val = unit === "d" ? minutes / 1440 : unit === "h" ? minutes / 60 : minutes;
  const mult = (u: string) => (u === "d" ? 1440 : u === "h" ? 60 : 1);
  return (
    <div className="row" style={{ gap: 6 }}>
      <input className="input" type="number" min={1} value={val} onChange={(ev) => onChange(Math.max(1, Math.round(Number(ev.target.value) * mult(unit))))} style={{ width: 84 }} />
      <select className="select" value={unit} onChange={(ev) => onChange(Math.max(1, Math.round(val * mult(ev.target.value))))} style={{ width: 104 }}>
        <option value="m">minutos</option><option value="h">horas</option><option value="d">dias</option>
      </select>
    </div>
  );
}
function CatFollowup({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const f = e.follow_up_config;
  const set = (p: Partial<FollowUpConfig>) => patch({ follow_up_config: { ...f, ...p } });
  const steps = f.manual_steps;
  const addStep = () => set({ manual_steps: [...steps, { delay_minutes: steps.length === 0 ? 60 : 1440, custom_message: "" }] });
  const updStep = (i: number, p: Partial<{ delay_minutes: number; custom_message: string }>) => set({ manual_steps: steps.map((s, idx) => (idx === i ? { ...s, ...p } : s)) });
  const remStep = (i: number) => set({ manual_steps: steps.filter((_, idx) => idx !== i) });
  return (
    <>
      <Field label="Como decidir as mensagens" hint="A IA escreve sozinha ou você define cada passo.">
        <Seg value={f.mode} options={[{ v: "ai_auto", l: "IA decide" }, { v: "manual", l: "Passos fixos" }]} onChange={(v) => set({ mode: v })} />
      </Field>

      {f.mode === "ai_auto" ? (
        <>
          <div className="fgrid">
            <Field label="Intensidade" hint="1 leve · 10 insistente."><input className="input" type="number" min={1} max={10} value={f.intensity} onChange={(ev) => set({ intensity: Number(ev.target.value) })} /></Field>
            <Field label="Máximo de tentativas"><input className="input" type="number" min={1} max={20} value={f.max_attempts} onChange={(ev) => set({ max_attempts: Number(ev.target.value) })} /></Field>
          </div>
          <div className="fgrid">
            <Field label="Primeiro follow-up depois de" hint="Tempo após o lead parar de responder."><DelayInput minutes={f.min_delay_minutes} onChange={(m) => set({ min_delay_minutes: m })} /></Field>
            <Field label="Último, no máximo até" hint="A IA espalha as tentativas até aqui."><DelayInput minutes={f.max_delay_minutes} onChange={(m) => set({ max_delay_minutes: m })} /></Field>
          </div>
          <Field label="Estilo e o que falar" hint="Oriente a IA: tom, o que reforçar, o que oferecer em cada retomada.">
            <textarea className="textarea" rows={4} maxLength={4000} value={f.custom_prompt || ""} onChange={(ev) => set({ custom_prompt: ev.target.value })} placeholder="Ex: Seja leve e sem pressão. No 1º lembrete, pergunte se ficou alguma dúvida. No 2º, ofereça uma ligação rápida. Nunca mande mais de 2 perguntas por mensagem." />
          </Field>
        </>
      ) : (
        <Field label="Passos do follow-up" hint="Cada tentativa: quando enviar (depois que o lead some) e o que falar. Texto vazio = a IA escreve na hora.">
          <div className="col" style={{ gap: 8 }}>
            {steps.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nenhum passo — adicione ao menos uma tentativa.</div>}
            {steps.map((s, i) => (
              <div key={i} className="card card--flat" style={{ padding: 10, background: "var(--surface-2)" }}>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <span className="eyebrow">Tentativa {i + 1}</span>
                  <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remStep(i)} aria-label="Remover"><Trash2 size={13} /></button>
                </div>
                <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Enviar depois de</span>
                  <DelayInput minutes={s.delay_minutes} onChange={(m) => updStep(i, { delay_minutes: m })} />
                </div>
                <textarea className="textarea" rows={2} value={s.custom_message || ""} onChange={(ev) => updStep(i, { custom_message: ev.target.value })} placeholder="O que falar nessa tentativa (deixe vazio = a IA decide)" />
              </div>
            ))}
            <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={addStep}><Plus /> Adicionar tentativa</button>
          </div>
        </Field>
      )}
    </>
  );
}

/* ─── Agendamento ───────────────────────────────────────────────── */
function CatScheduling({ e, patch, isRecruitment }: { e: Editable; patch: (p: Partial<Editable>) => void; isRecruitment: boolean }) {
  const pb = e.post_booking;
  const set = (p: Partial<PostBooking>) => patch({ post_booking: { ...pb, ...p } });
  return (
    <>
      <Field label="Calendário"><span className="muted" style={{ fontSize: 13 }}>Conectado pela agência (Spark Leads). A escolha de calendário entra em breve aqui.</span></Field>
      <div className="fgrid">
        <Field label="Especialista responsável" hint="Nome de quem conduz a reunião/entrevista."><input className="input" value={e.specialist_name} onChange={(ev) => patch({ specialist_name: ev.target.value })} placeholder="Ex: Dr. Pereira" /></Field>
        <Field label="Horário preferido" hint="Faixa que o agente sugere primeiro."><Seg value={e.preferred_time_slot || "any"} options={[{ v: "any", l: "Qualquer" }, { v: "morning", l: "Manhã" }, { v: "afternoon_evening", l: "Tarde/Noite" }]} onChange={(v) => patch({ preferred_time_slot: v })} /></Field>
      </div>
      <Field label="Depois de agendar"><Seg value={pb.behavior} options={[{ v: "stop_and_handoff", l: "Passar pra humano" }, { v: "continue_until_appointment", l: "Continuar até a reunião" }]} onChange={(v) => set({ behavior: v })} /></Field>
      <Field label="Mensagem ao passar pra humano"><textarea className="textarea" rows={2} value={pb.handoff_message} onChange={(ev) => set({ handoff_message: ev.target.value })} placeholder="Ex: Perfeito! Já agendei. Um especialista vai te acompanhar a partir daqui." /></Field>
      <Toggle label="Permitir reagendamento" checked={pb.allow_reschedule} onChange={() => set({ allow_reschedule: !pb.allow_reschedule })} />
      {isRecruitment && <Toggle label="Perguntar documentação (EUA)" hint="Confirma Social Security e permissão de trabalho." checked={e.check_legal_docs} onChange={() => patch({ check_legal_docs: !e.check_legal_docs })} />}
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Como o bot para e devolve a conversa pra uma pessoa fica na aba <strong>Pausa do bot</strong>.</p>
    </>
  );
}

/* ─── Prospecção ────────────────────────────────────────────────── */
function CatOutreach({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const o = e.outreach;
  const set = (p: Partial<Outreach>) => patch({ outreach: { ...o, ...p } });
  return (
    <>
      <Field label="Quem o agente aborda" hint="Contatos com estas tags (separe por vírgula). Uma ou mais.">
        <input className="input" value={o.tag_filter.tags.join(", ")} onChange={(ev) => set({ tag_filter: { ...o.tag_filter, tags: ev.target.value.split(",").map((t) => t.trim()).filter(Boolean) } })} placeholder="ex: feirao_2026, sem_contato" />
        <div style={{ marginTop: 8 }}>
          <Seg value={o.tag_filter.match} options={[{ v: "any" as const, l: "Qualquer uma das tags" }, { v: "all" as const, l: "Todas as tags" }]} onChange={(v) => set({ tag_filter: { ...o.tag_filter, match: v } })} />
        </div>
      </Field>
      <SubHd>Ritmo de envio</SubHd>
      <div className="fgrid">
        <Field label="Quantas pessoas por dia" hint="O agente não aborda mais que isso num dia."><input className="input" type="number" min={1} max={5000} value={o.daily_cap} onChange={(ev) => set({ daily_cap: Number(ev.target.value) })} /></Field>
        <Field label="Velocidade (por hora)" hint="Espalha no tempo, sem rajada."><input className="input" type="number" min={1} max={500} value={o.rate_per_hour} onChange={(ev) => set({ rate_per_hour: Number(ev.target.value) })} /></Field>
      </div>
      <Field label="Horário de envio" hint="Quando ligado, só dispara dentro do horário definido na aba Atendimento. Desligado = envia a qualquer hora.">
        <Toggle label="Só dentro do horário de atendimento" checked={o.respect_working_hours} onChange={() => set({ respect_working_hours: !o.respect_working_hours })} />
      </Field>
      <div className="card card--flat" style={{ padding: 12, background: "var(--primary-soft)", margin: "4px 0 4px" }}>
        <span style={{ fontSize: 12.5, color: "var(--primary-ink)" }}>
          📋 Aborda até <strong>{o.daily_cap} pessoas/dia</strong>, no ritmo de ~{o.rate_per_hour}/hora, {o.respect_working_hours ? "dentro do horário de atendimento" : "a qualquer hora do dia"}.
        </span>
      </div>
      <Field label="Mensagem de abertura" hint="A 1ª mensagem que o agente manda. Vazio = a IA cria com base no propósito.">
        <textarea className="textarea" rows={3} value={o.opening_message} onChange={(ev) => set({ opening_message: ev.target.value })} placeholder="Ex: Oi {first_name}! Vi que você passou no nosso feirão — posso te ajudar com a cotação?" />
      </Field>
      <div className="card card--flat" style={{ padding: 12, background: "var(--surface-2)", marginTop: 4 }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          Depois de iniciar, o agente <strong>conduz</strong> a conversa normalmente (qualifica, agenda…). O disparo real é liberado pela agência (supervisionado) antes de ligar em produção.
        </span>
      </div>
    </>
  );
}

/* ─── Conhecimento ──────────────────────────────────────────────── */
const KB_TEMPLATES: { v: string; l: string; d: string }[] = [
  { v: "national_life_group", l: "National Life Group", d: "Produtos, IUL, regras de carrier" },
  { v: "agency_brazillionaires", l: "Brazillionaires", d: "Material e processos da agência" },
];
function CatKnowledge({ e, patch, agentId }: { e: Editable; patch: (p: Partial<Editable>) => void; agentId: string }) {
  const toggleKb = (v: string) => patch({ enabled_kbs: e.enabled_kbs.includes(v) ? e.enabled_kbs.filter((k) => k !== v) : [...e.enabled_kbs, v] });
  return (
    <>
      <Field label="O que o agente sabe da agência" hint="O essencial em texto: produtos, preços, regras, FAQ. Entra direto no atendimento.">
        <textarea className="textarea" rows={5} maxLength={10000} value={e.knowledge_base_instructions} onChange={(ev) => patch({ knowledge_base_instructions: ev.target.value })} placeholder={"Ex: Planos família a partir de $X. Atendemos FL, GA, TX. Não cite valores sem confirmar o estado. FAQ: ..."} />
      </Field>

      <SubHd>Documentos & arquivos</SubHd>
      <p className="fstack__hint" style={{ marginTop: -4, marginBottom: 10 }}>Suba PDF, Excel, Word, CSV ou foto — o sistema lê o conteúdo e o agente passa a usar. Ou cole um texto avulso.</p>
      <KbManager agentId={agentId} />

      <SubHd>Templates de conhecimento</SubHd>
      <Field label="Bibliotecas prontas" hint="Pacotes mantidos pela Spark — o agente consulta sob demanda (busca por relevância).">
        <div className="col" style={{ gap: 8 }}>
          {KB_TEMPLATES.map((kb) => {
            const on = e.enabled_kbs.includes(kb.v);
            return (
              <label key={kb.v} className="row between" style={{ gap: 10, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "var(--r-md)", cursor: "pointer" }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{kb.l}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{kb.d}</div>
                </div>
                <div className="switch" role="switch" aria-checked={on} onClick={() => toggleKb(kb.v)} />
              </label>
            );
          })}
        </div>
      </Field>
    </>
  );
}

/* ─── Automações ────────────────────────────────────────────────── */
const EVENT_OPTS: { v: string; l: string }[] = [
  { v: "qualified", l: "Lead qualificado" }, { v: "booked", l: "Reunião agendada" },
  { v: "handed_off", l: "Passou pra humano" }, { v: "disqualified", l: "Lead desqualificado" },
];
const ACTION_OPTS: { v: AutomationAction["type"]; l: string }[] = [
  { v: "add_tag", l: "Adicionar tag" }, { v: "remove_tag", l: "Remover tag" },
  { v: "move_pipeline", l: "Mover no funil" }, { v: "update_field", l: "Atualizar campo" },
  { v: "send_text_fixed", l: "Enviar mensagem" }, { v: "send_media", l: "Enviar mídia" },
  { v: "pause_ai", l: "Pausar a IA" }, { v: "webhook", l: "Chamar webhook" },
];
function triggerEvent(a: AutomationRule): string {
  if (a.trigger?.kind === "event") return a.trigger.event;
  if (a.trigger?.kind === "on_data_field_set") return "__field__";
  return a.event || "qualified";
}
function CatAutomations({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const list = e.automations;
  const add = () => patch({ automations: [...list, { id: rid(), trigger: { kind: "event", event: "qualified" }, actions: [{ type: "add_tag", tag: "" }] }] });
  const upd = (i: number, p: Partial<AutomationRule>) => patch({ automations: list.map((r, idx) => (idx === i ? { ...r, ...p } : r)) });
  const rem = (i: number) => patch({ automations: list.filter((_, idx) => idx !== i) });

  const setTrigger = (i: number, v: string) => {
    if (v === "__field__") upd(i, { trigger: { kind: "on_data_field_set", field_key: "", operator: "any_value" }, event: undefined });
    else upd(i, { trigger: { kind: "event", event: v }, event: undefined });
  };
  const setActions = (i: number, actions: AutomationAction[]) => upd(i, { actions });

  return (
    <Field label="Regras" hint="Quando um gatilho acontecer, o agente executa as ações.">
      <div className="col" style={{ gap: 10 }}>
        {list.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nenhuma automação. Ex: ao qualificar, adicionar a tag “quente”.</div>}
        {list.map((a, i) => {
          const ev = triggerEvent(a);
          const isField = a.trigger?.kind === "on_data_field_set";
          return (
            <div key={a.id} className="card card--flat" style={{ padding: 12, background: "var(--surface-2)" }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <span className="eyebrow">Quando</span>
                <button className="btn btn--quiet btn--icon btn--sm" onClick={() => rem(i)} aria-label="Remover"><Trash2 size={13} /></button>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <select className="select" value={ev} onChange={(evt) => setTrigger(i, evt.target.value)} style={{ width: 200 }}>
                  {EVENT_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                  <option value="__field__">Campo preenchido…</option>
                </select>
                {isField && a.trigger?.kind === "on_data_field_set" && (<>
                  <input className="input" value={a.trigger.field_key} onChange={(evt) => upd(i, { trigger: { ...a.trigger as Extract<AutomationRule["trigger"], { kind: "on_data_field_set" }>, field_key: evt.target.value } })} placeholder="chave do campo" style={{ width: 150 }} />
                  <select className="select" value={a.trigger.operator} onChange={(evt) => upd(i, { trigger: { ...a.trigger as Extract<AutomationRule["trigger"], { kind: "on_data_field_set" }>, operator: evt.target.value as "any_value" | "equals" | "contains" | "matches_regex" } })} style={{ width: 140 }}>
                    <option value="any_value">tem valor</option><option value="equals">igual a</option><option value="contains">contém</option><option value="matches_regex">regex</option>
                  </select>
                  {a.trigger.operator !== "any_value" && <input className="input grow" value={a.trigger.value || ""} onChange={(evt) => upd(i, { trigger: { ...a.trigger as Extract<AutomationRule["trigger"], { kind: "on_data_field_set" }>, value: evt.target.value } })} placeholder="valor" />}
                </>)}
              </div>
              <div className="eyebrow" style={{ marginTop: 12, marginBottom: 6 }}>Fazer</div>
              <ActionList actions={a.actions} onChange={(acts) => setActions(i, acts)} />
            </div>
          );
        })}
        <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={add}><Plus /> Nova automação</button>
      </div>
    </Field>
  );
}
function ActionList({ actions, onChange }: { actions: AutomationAction[]; onChange: (a: AutomationAction[]) => void }) {
  const upd = (i: number, p: Partial<AutomationAction>) => onChange(actions.map((a, idx) => (idx === i ? { ...a, ...p } : a)));
  const rem = (i: number) => onChange(actions.filter((_, idx) => idx !== i));
  const add = () => onChange([...actions, { type: "add_tag", tag: "" }]);
  return (
    <div className="col" style={{ gap: 6 }}>
      {actions.map((a, i) => (
        <div key={i} className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="select" value={a.type} onChange={(ev) => upd(i, { type: ev.target.value as AutomationAction["type"] })} style={{ width: 170 }}>
            {ACTION_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          {(a.type === "add_tag" || a.type === "remove_tag") && <input className="input grow" value={a.tag || ""} onChange={(ev) => upd(i, { tag: ev.target.value })} placeholder="nome da tag" />}
          {a.type === "move_pipeline" && (<>
            <input className="input" value={a.pipeline_id || ""} onChange={(ev) => upd(i, { pipeline_id: ev.target.value })} placeholder="ID do funil" style={{ width: 150 }} />
            <input className="input grow" value={a.stage_id || ""} onChange={(ev) => upd(i, { stage_id: ev.target.value })} placeholder="ID da etapa" />
          </>)}
          {a.type === "update_field" && (<>
            <input className="input" value={a.field_key || ""} onChange={(ev) => upd(i, { field_key: ev.target.value })} placeholder="campo" style={{ width: 150 }} />
            <input className="input grow" value={a.field_value || ""} onChange={(ev) => upd(i, { field_value: ev.target.value })} placeholder="valor" />
          </>)}
          {a.type === "send_text_fixed" && <input className="input grow" value={a.text || ""} onChange={(ev) => upd(i, { text: ev.target.value })} placeholder="mensagem a enviar" />}
          {a.type === "send_media" && (<>
            <input className="input" value={a.media_id || ""} onChange={(ev) => upd(i, { media_id: ev.target.value })} placeholder="ID da mídia" style={{ width: 150 }} />
            <input className="input grow" value={a.media_caption || ""} onChange={(ev) => upd(i, { media_caption: ev.target.value })} placeholder="legenda (opcional)" />
          </>)}
          {a.type === "pause_ai" && <input className="input" type="number" min={0} value={a.pause_minutes ?? 0} onChange={(ev) => upd(i, { pause_minutes: Number(ev.target.value) })} placeholder="min (0=indef.)" style={{ width: 130 }} />}
          {a.type === "webhook" && <input className="input grow" value={a.webhook_url || ""} onChange={(ev) => upd(i, { webhook_url: ev.target.value })} placeholder="https://…" />}
          <button className="btn btn--quiet btn--icon btn--sm" onClick={() => rem(i)} aria-label="Remover"><Trash2 size={13} /></button>
        </div>
      ))}
      <button className="btn btn--quiet btn--sm" style={{ alignSelf: "flex-start" }} onClick={add}><Plus /> Ação</button>
    </div>
  );
}

/* ─── Pausa do bot ──────────────────────────────────────────────── */
function CatPause({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const auto = e.auto_pause_on_human_message;
  const hm = e.handoff_messages;
  const addH = () => patch({ handoff_messages: [...hm, { id: rid(), label: "", text: "", auto_deactivate: true }] });
  const updH = (i: number, p: Partial<HandoffMessage>) => patch({ handoff_messages: hm.map((m, idx) => (idx === i ? { ...m, ...p } : m)) });
  const remH = (i: number) => patch({ handoff_messages: hm.filter((_, idx) => idx !== i) });
  return (
    <>
      <Field label="Quando o bot deve pausar?" hint="O sistema reconhece quando alguém da equipe responde manualmente pelo Spark Leads (não foi a IA) e devolve a conversa pra essa pessoa.">
        <div className="col" style={{ gap: 10 }}>
          <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input type="radio" name="pausemode" checked={auto} onChange={() => patch({ auto_pause_on_human_message: true })} style={{ marginTop: 3 }} />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>Sempre que um humano responder <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>· recomendado</span></div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>Qualquer mensagem enviada manualmente (por você ou pela equipe) pausa o bot naquele contato.</div>
            </div>
          </label>
          <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input type="radio" name="pausemode" checked={!auto} onChange={() => patch({ auto_pause_on_human_message: false })} style={{ marginTop: 3 }} />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>Só com mensagens específicas</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>O bot continua mesmo se você responder — só pausa quando enviar uma das mensagens cadastradas abaixo (filtro).</div>
            </div>
          </label>
        </div>
      </Field>

      {auto ? (
        <div className="card card--flat" style={{ padding: 12, background: "var(--surface-2)", marginTop: 4 }}>
          <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
            ✓ O bot pausa assim que detectar uma resposta manual no Spark Leads. Mensagens enviadas pela própria IA (ou por automações) <strong>não</strong> pausam.
          </span>
        </div>
      ) : (
        <Field label="Mensagens que pausam o bot" hint="Quando você enviar exatamente uma destas ao lead pelo Spark Leads, o bot para naquele contato.">
          <div className="col" style={{ gap: 8 }}>
            {hm.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nenhuma mensagem cadastrada — adicione ao menos uma, senão o bot nunca pausa.</div>}
            {hm.map((m, i) => (
              <div key={m.id} className="card card--flat" style={{ padding: 10, background: "var(--surface-2)" }}>
                <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                  <input className="input grow" value={m.label} onChange={(ev) => updH(i, { label: ev.target.value })} placeholder="Apelido (ex: Encerrei eu mesmo)" />
                  <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remH(i)} aria-label="Remover"><Trash2 size={13} /></button>
                </div>
                <textarea className="textarea" rows={2} value={m.text} onChange={(ev) => updH(i, { text: ev.target.value })} placeholder="Texto exato da mensagem que pausa o bot" />
                <label className="row" style={{ gap: 8, fontSize: 12.5, color: "var(--ink-3)", marginTop: 6, cursor: "pointer" }}>
                  <div className="switch" role="switch" aria-checked={m.auto_deactivate} onClick={() => updH(i, { auto_deactivate: !m.auto_deactivate })} /> Pausar a IA ao enviar
                </label>
              </div>
            ))}
            <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={addH}><Plus /> Nova mensagem</button>
          </div>
        </Field>
      )}
    </>
  );
}

/* ─── Limites & avisos ──────────────────────────────────────────── */
function CatLimits({ e, patch, isRep }: { e: Editable; patch: (p: Partial<Editable>) => void; isRep: boolean }) {
  const q = e.quiet_hours;
  const setQ = (p: Partial<Quiet>) => patch({ quiet_hours: { ...q, ...p } });
  const nt = e.notifications;
  const setN = (p: Partial<Notif>) => patch({ notifications: { ...nt, ...p } });
  const dr = e.deactivation_rules;
  const addD = () => patch({ deactivation_rules: [...dr, { id: rid(), type: "tag_added", tag: "" }] });
  const updD = (i: number, p: Partial<DeactivationRule>) => patch({ deactivation_rules: dr.map((r, idx) => (idx === i ? { ...r, ...p } : r)) });
  const remD = (i: number) => patch({ deactivation_rules: dr.filter((_, idx) => idx !== i) });
  return (
    <>
      <SubHd>Comportamento</SubHd>
      {isRep && (
        <Field label="Quando pedir confirmação" hint="Antes de agir no Spark Leads.">
          <div className="col" style={{ gap: 8 }}>
            {([["always", "Sempre — antes de qualquer ação"], ["medium_and_high", "Em ações importantes (recomendado)"], ["high_only", "Só nas mais sensíveis"]] as [ConfMode, string][]).map(([v, l]) => (
              <label key={v} className="row" style={{ gap: 10, fontSize: 13.5, cursor: "pointer" }}><input type="radio" name="conf" checked={e.confirmation_mode === v} onChange={() => patch({ confirmation_mode: v })} /> <span>{l}</span></label>
            ))}
          </div>
        </Field>
      )}
      <div className="fgrid">
        <Field label="Espera antes de responder" hint="Segundos — agrupa mensagens em sequência."><input className="input" type="number" min={5} max={60} value={e.debounce_seconds} onChange={(ev) => patch({ debounce_seconds: Number(ev.target.value) })} /></Field>
        <Field label="Máx. mensagens por conversa"><input className="input" type="number" min={10} max={200} value={e.max_messages_per_conversation} onChange={(ev) => patch({ max_messages_per_conversation: Number(ev.target.value) })} /></Field>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Quando o bot para e devolve a conversa pra uma pessoa fica na aba <strong>Pausa do bot</strong>.</p>
      {isRep && (
        <>
          <div className="fgrid" style={{ marginTop: 6 }}>
            <Field label="Proativos por dia" hint="Quantas vezes inicia conversa."><input className="input" type="number" min={0} max={100} value={e.daily_proactive_limit} onChange={(ev) => patch({ daily_proactive_limit: Number(ev.target.value) })} /></Field>
          </div>
          <Field label="Horário de silêncio" hint="Não envia nesse intervalo.">
            <div className="row" style={{ gap: 8 }}>
              <div className="switch" role="switch" aria-checked={q.enabled} onClick={() => setQ({ enabled: !q.enabled })} />
              {q.enabled && <><input className="input" type="time" value={q.start} onChange={(ev) => setQ({ start: ev.target.value })} style={{ width: 120 }} /><span className="muted">até</span><input className="input" type="time" value={q.end} onChange={(ev) => setQ({ end: ev.target.value })} style={{ width: 120 }} /></>}
            </div>
          </Field>
        </>
      )}

      <SubHd>Mídia</SubHd>
      <Toggle label="Transcrever áudios" checked={e.enable_audio_transcription} onChange={() => patch({ enable_audio_transcription: !e.enable_audio_transcription })} />
      <Toggle label="Analisar imagens" checked={e.enable_image_analysis} onChange={() => patch({ enable_image_analysis: !e.enable_image_analysis })} />
      <Toggle label="Ler PDFs" checked={e.enable_pdf_reading} onChange={() => patch({ enable_pdf_reading: !e.enable_pdf_reading })} />
      <Toggle label="Resumo automático em nota" checked={e.enable_summary_notes} onChange={() => patch({ enable_summary_notes: !e.enable_summary_notes })} />

      <SubHd>Avisos por email</SubHd>
      <Toggle label="Lead qualificado" checked={nt.on_qualified} onChange={() => setN({ on_qualified: !nt.on_qualified })} />
      <Toggle label="Reunião agendada" checked={nt.on_booked} onChange={() => setN({ on_booked: !nt.on_booked })} />
      <Toggle label="Passou pra humano" checked={nt.on_handed_off} onChange={() => setN({ on_handed_off: !nt.on_handed_off })} />
      <Field label="Email para avisos"><input className="input" type="email" value={nt.notification_email} onChange={(ev) => setN({ notification_email: ev.target.value })} placeholder="voce@agencia.com" style={{ maxWidth: 360 }} /></Field>

      {!isRep && (
        <>
          <SubHd>Desativar o agente automaticamente</SubHd>
          <Field label="Regras de parada" hint="Quando isto acontecer, a IA para de responder aquele lead.">
            <div className="col" style={{ gap: 8 }}>
              {dr.map((r, i) => (
                <div key={r.id} className="row" style={{ gap: 8, alignItems: "center", background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8, flexWrap: "wrap" }}>
                  <select className="select" value={r.type} onChange={(ev) => updD(i, { type: ev.target.value as DeactivationRule["type"] })} style={{ width: 170 }}>
                    <option value="tag_added">Tag adicionada</option><option value="tag_removed">Tag removida</option><option value="custom_field_equals">Campo = valor</option>
                  </select>
                  {(r.type === "tag_added" || r.type === "tag_removed") && <input className="input grow" value={r.tag || ""} onChange={(ev) => updD(i, { tag: ev.target.value })} placeholder="nome da tag" />}
                  {r.type === "custom_field_equals" && (<>
                    <input className="input" value={r.field_key || ""} onChange={(ev) => updD(i, { field_key: ev.target.value })} placeholder="campo" style={{ width: 150 }} />
                    <input className="input grow" value={r.field_value || ""} onChange={(ev) => updD(i, { field_value: ev.target.value })} placeholder="valor" />
                  </>)}
                  <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remD(i)} aria-label="Remover"><Trash2 size={13} /></button>
                </div>
              ))}
              <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={addD}><Plus /> Nova regra</button>
            </div>
          </Field>
        </>
      )}
    </>
  );
}
