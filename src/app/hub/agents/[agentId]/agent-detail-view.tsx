"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft, Play, Pause, Check, Plus, Trash2,
  Sparkles, Clock, Calendar, MessageCircle, Users, Send, FileText, Shield, Zap,
  Wand2, Workflow, PauseCircle, Bell, Crosshair, BookOpen,
  type LucideIcon,
} from "lucide-react";
import { AMark, StatusBadge, ChannelChip, PriceBadge } from "@/components/hub/primitives";
// F35 (Pedro 2026-05-28): pickers dinâmicos pra targeting (tag/pipeline/cf).
import { TagPicker, TagsMultiPicker, PipelineStagePicker, CustomFieldPicker } from "@/components/hub/pickers";
import { useHubSession } from "@/components/hub/hub-session";
import { TestChat } from "./test-chat";
import { KbManager } from "./kb-manager";
import type { HubAgentDetail } from "@/lib/hub/data";
import type { AgentStatus, ChannelKey } from "@/components/hub/types";
import { channelsFromDb, channelsToDb, nonUiChannels, CHANNEL_LABEL } from "@/components/hub/types";
import type {
  DataField, FollowUpConfig, WorkingHoursConfig, WorkingHoursDay,
  TargetingRule, TargetingRules, TargetingRuleSet, TargetingGroup, MessageMatchOp, AutomationRule, AutomationAction, DeactivationRule, HandoffMessage,
} from "@/types/agent";

const TEMPLATE_LABEL: Record<string, string> = { sparkbot: "SparkBot", sales: "Vendas", recruitment: "Recrutamento", custom: "Personalizado" };

type ConfMode = "always" | "medium_and_high" | "high_only";
type Objective = "qualification_only" | "qualification_and_booking" | "booking_only";
type Cat =
  | "identity" | "tone"
  // F27 (Pedro 2026-05-28): nova Cat "activation" — quando o agente atende
  // (targeting_rules). Antes ficava enterrado embaixo de "Qualificação" como
  // "Filtros de público". Pedro reclamou que não achava — agora é Cat própria.
  | "activation"
  // F37 (Pedro 2026-05-29): memória do lead (carrega histórico GHL) + handoff
  // inteligente (decide responder vs notificar rep via SparkBot).
  | "memory"
  | "channel" | "qualification" | "scheduling" | "followup" | "outreach" | "knowledge"
  | "hours" | "automations" | "pause" | "limits"
  | "proactivity";

const num = (v: unknown, d: number) => (typeof v === "number" && !isNaN(v) ? v : d);
// Clamp pra faixa do schema — legado fora da faixa derrubava o PUT inteiro (400).
const clampNum = (v: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, num(v, d)));
const str = (v: unknown) => (typeof v === "string" ? v : "");
const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);
const rid = () => Math.random().toString(36).slice(2, 10);

/** Uma folha de targeting só "conta" se tiver valor preenchido — senão é regra
 *  fantasma (UI semeia regra vazia ao clicar "+"). Limpamos no save pra não
 *  persistir lixo que o runtime trataria como neutro/ruidoso. */
function isCompleteLeaf(r: TargetingRule): boolean {
  switch (r.type) {
    case "message":
      return r.message_operator === "in"
        ? !!r.message_values?.some((v) => v.trim())
        : !!r.message_value?.trim();
    case "tag":
      return !!r.tag?.trim();
    case "custom_field":
      return !!r.custom_field_key?.trim();
    case "pipeline_stage":
      return !!r.pipeline_stage_id?.trim();
    default:
      return false;
  }
}

/** Remove folhas incompletas e grupos vazios antes de salvar. Aceita array
 *  legado (filtra folhas) ou set v2 (filtra folhas + drop grupos sem regra). */
function cleanTargetingRules(tr: TargetingRules): TargetingRules {
  if (Array.isArray(tr)) return tr.filter(isCompleteLeaf);
  const groups = tr.groups
    .map((g) => ({ ...g, rules: g.rules.filter(isCompleteLeaf) }))
    .filter((g) => g.rules.length > 0);
  // Set v2 que ficou SEM grupo (rep limpou tudo) → colapsa pro array vazio
  // canônico (= "sem targeting, responde a todos"). Evita persistir um objeto v2
  // vazio {version,groups:[]} que confunde leitura/auditoria (review 2026-06-18).
  if (groups.length === 0) return [];
  return { ...tr, groups };
}

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
  targeting_rules: TargetingRules;
  channels: ChannelKey[];
  extra_channels: string[]; // canais do DB que o /hub não edita (ex: Email) — preservados
  follow_up_config: FollowUpConfig;
  post_booking: PostBooking;
  specialist_name: string;
  preferred_time_slot: string;
  calendar_id: string;
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
  // Pedro 2026-05-28: 4 campos missing-UI / dead-write (auditoria de gaps).
  // ai_model antes era display read-only mas NÃO no PUT (mentira de UI);
  // fallback_model/disabled_tools/system_prompt_override existiam no schema
  // (00047 + validation.ts) mas zero UI — admin só editava via SQL.
  ai_model: string;
  fallback_model: string;
  disabled_tools: string[];
  system_prompt_override: string;
  // F37 (Pedro 2026-05-29): memória do lead + handoff inteligente.
  lead_history_config: import("@/types/agent").LeadHistoryConfig;
  handoff_policy: import("@/types/agent").HandoffPolicy;
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
    // v2 (Pedro 2026-06-17): preserva array flat legado OU set v2 (grupos E/OU).
    targeting_rules: (c.targeting_rules as TargetingRules | null) ?? [],
    channels: channelsFromDb(c.enabled_channels),
    extra_channels: nonUiChannels(c.enabled_channels),
    follow_up_config: {
      enabled: bool(fu.enabled), mode: fu.mode === "manual" ? "manual" : "ai_auto",
      intensity: clampNum(fu.intensity, 1, 10, 5), max_attempts: clampNum(fu.max_attempts, 1, 20, 3),
      min_delay_minutes: Math.max(1, num(fu.min_delay_minutes, 10)), max_delay_minutes: Math.max(1, num(fu.max_delay_minutes, 10080)),
      custom_prompt: str(fu.custom_prompt), manual_steps: Array.isArray(fu.manual_steps) ? fu.manual_steps : [],
    },
    post_booking: { behavior: pb.behavior === "continue_until_appointment" ? "continue_until_appointment" : "stop_and_handoff", handoff_message: str(pb.handoff_message), allow_reschedule: bool(pb.allow_reschedule, true) },
    specialist_name: str(c.specialist_name),
    preferred_time_slot: str(c.preferred_time_slot),
    calendar_id: str(c.calendar_id),
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
      rate_per_hour: clampNum(oc.rate_per_hour, 1, 500, 20),
      daily_cap: clampNum(oc.daily_cap, 1, 5000, 100),
      respect_working_hours: bool(oc.respect_working_hours, true),
      opening_message: str(oc.opening_message),
    },
    // Pedro 2026-05-28: reads novos pros 4 campos. ai_model "" = vai pro padrão
    // do dispatcher (Sonnet/Haiku). disabled_tools [] = nenhuma desabilitada.
    ai_model: str(c.ai_model),
    fallback_model: str(c.fallback_model),
    disabled_tools: Array.isArray(c.disabled_tools) ? (c.disabled_tools as string[]) : [],
    system_prompt_override: str(c.system_prompt_override),
    // F37 (Pedro 2026-05-29): defaults vêm do schema (00096); se config legado
    // não tem, usa defaults aplicados via getLeadHistoryConfig/getHandoffPolicy.
    lead_history_config: {
      enabled: bool((c.lead_history_config as Record<string, unknown> | null)?.enabled, false),
      messages_count: num((c.lead_history_config as Record<string, unknown> | null)?.messages_count, 20),
      include_notes: bool((c.lead_history_config as Record<string, unknown> | null)?.include_notes, true),
      include_opportunities: bool((c.lead_history_config as Record<string, unknown> | null)?.include_opportunities, true),
      include_tags: bool((c.lead_history_config as Record<string, unknown> | null)?.include_tags, true),
    },
    handoff_policy: {
      enabled: bool((c.handoff_policy as Record<string, unknown> | null)?.enabled, false),
      skip_if_human_replied_within_minutes: num((c.handoff_policy as Record<string, unknown> | null)?.skip_if_human_replied_within_minutes, 60),
      skip_if_lead_requested_human: bool((c.handoff_policy as Record<string, unknown> | null)?.skip_if_lead_requested_human, true),
      notify_rep_via_sparkbot: bool((c.handoff_policy as Record<string, unknown> | null)?.notify_rep_via_sparkbot, true),
      notify_on_opp_stage_closed: bool((c.handoff_policy as Record<string, unknown> | null)?.notify_on_opp_stage_closed, true),
      custom_keywords_handoff: Array.isArray((c.handoff_policy as Record<string, unknown> | null)?.custom_keywords_handoff)
        ? ((c.handoff_policy as { custom_keywords_handoff: string[] }).custom_keywords_handoff)
        : ["humano", "atendente", "pessoa", "falar com alguem"],
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
// F27 (Pedro 2026-05-28): "activation" é lead-only — SparkBot fala com 1 rep só,
// não tem targeting_rules. Adicionado pra esconder da Cat-rail no SparkBot.
// F37 (Pedro 2026-05-29): "memory" lead-only — carrega histórico do contato
// do GHL e regras de handoff inteligente; SparkBot rep-facing tem outro pipeline.
const LEAD_ONLY = new Set<Cat>(["activation", "memory", "channel", "qualification", "scheduling", "followup", "outreach", "automations"]);

const GROUPS: { id: string; label: string }[] = [
  { id: "comportamento", label: "Comportamento" },
  { id: "capacidades", label: "Capacidades" },
  { id: "operacao", label: "Operação" },
];
const CATS: { id: Cat; label: string; icon: LucideIcon; group: string }[] = [
  { id: "identity", label: "Identidade", icon: Sparkles, group: "comportamento" },
  { id: "tone", label: "Tom & estilo", icon: Wand2, group: "comportamento" },
  // F27 (Pedro 2026-05-28): Cat "Ativação" no grupo comportamento (define quando
  // o agente ENTRA em ação — fundamental, fica perto da identidade).
  { id: "activation", label: "Ativação", icon: Crosshair, group: "comportamento" },
  // F37 (Pedro 2026-05-29): Cat "Memória do lead" — toggle pra puxar histórico
  // do contato do Spark Leads + handoff inteligente (decide responder vs
  // notificar rep humano). Fica em comportamento pois define COMO o agente
  // entende o contexto antes de agir.
  { id: "memory", label: "Memória do lead", icon: BookOpen, group: "comportamento" },
  { id: "channel", label: "Canais", icon: MessageCircle, group: "capacidades" },
  { id: "qualification", label: "Qualificação", icon: Users, group: "capacidades" },
  { id: "scheduling", label: "Agendamento", icon: Calendar, group: "capacidades" },
  { id: "followup", label: "Follow-up", icon: Send, group: "capacidades" },
  // F34 (Pedro 2026-05-28): Cat "Prospecção" removida do rail — virou
  // sub-modo "Disparo em massa" dentro de Cat Ativação. Editor + estado
  // (e.outreach + módulo outreach enabled) preservados. Toggle do módulo
  // continua disponível indiretamente via switch de tipo na Ativação.
  { id: "knowledge", label: "Conhecimento", icon: FileText, group: "capacidades" },
  { id: "hours", label: "Atendimento", icon: Clock, group: "operacao" },
  { id: "automations", label: "Automações", icon: Workflow, group: "operacao" },
  { id: "pause", label: "Pausa do bot", icon: PauseCircle, group: "operacao" },
  { id: "limits", label: "Limites & avisos", icon: Shield, group: "operacao" },
  { id: "proactivity", label: "Proatividade", icon: Bell, group: "operacao" },
];
const CAT_META: Record<Cat, { title: string; sub: string }> = {
  identity: { title: "Identidade", sub: "Quem é o agente, como se apresenta e o que sabe da agência." },
  tone: { title: "Tom & estilo", sub: "O jeito de conversar e exemplos de resposta." },
  // F27 (Pedro 2026-05-28): Cat "Ativação" — quando/em quem o agente é ativado.
  activation: { title: "Ativação", sub: "Quais contatos o agente atende — por tag, etapa do funil ou campo personalizado." },
  memory: { title: "Memória do lead", sub: "Carregar histórico do contato no Spark Leads e decidir quando notificar você em vez de responder." },
  channel: { title: "Canais", sub: "Por onde o agente conversa (conectado pela agência)." },
  qualification: { title: "Qualificação de leads", sub: "O que perguntar pra identificar um bom lead." },
  scheduling: { title: "Agendamento", sub: "Como o agente marca e o que faz depois." },
  followup: { title: "Follow-up", sub: "Retomada automática de quem não respondeu." },
  outreach: { title: "Prospecção", sub: "O agente inicia conversas com uma lista (por tag), no ritmo certo." },
  knowledge: { title: "Conhecimento", sub: "Documentos e bases que o agente consulta." },
  hours: { title: "Horário de atendimento", sub: "Quando o agente pode responder." },
  automations: { title: "Automações", sub: "Ações automáticas quando algo acontece na conversa." },
  pause: { title: "Pausa do bot", sub: "Quando o agente para e devolve a conversa pra uma pessoa." },
  limits: { title: "Limites & avisos", sub: "Volume, confirmações, silêncio, mídia e notificações." },
  proactivity: { title: "Proatividade", sub: "Quando o SparkBot te procura sozinho — resumos agendados e alertas." },
};

export function AgentDetailView({ detail }: { detail: HubAgentDetail }) {
  const router = useRouter();
  const isSparkbot = detail.template_key === "sparkbot";
  const isLead = detail.audience === "lead";
  const isRecruitment = detail.template_key === "recruitment";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (detail.config ?? {}) as Record<string, any>;
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
      const cleanTargeting = cleanTargetingRules(e.targeting_rules);
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
          // clampNum no SAVE: os inputs number deixam digitar livre (0/25/vazio),
          // mas o zod do PUT rejeita fora de range e derruba o save inteiro (400).
          // Clampar aqui garante payload válido sem travar a digitação.
          debounce_seconds: clampNum(e.debounce_seconds, 5, 60, 10), auto_pause_on_human_message: e.auto_pause_on_human_message,
          data_fields: e.data_fields, targeting_rules: cleanTargeting,
          enabled_channels: [...channelsToDb(e.channels), ...e.extra_channels],
          follow_up_config: { ...e.follow_up_config, enabled: enabled.has("followup"), intensity: clampNum(e.follow_up_config.intensity, 1, 10, 5), max_attempts: clampNum(e.follow_up_config.max_attempts, 1, 20, 3) },
          post_booking: e.post_booking,
          specialist_name: e.specialist_name, preferred_time_slot: e.preferred_time_slot, calendar_id: e.calendar_id, check_legal_docs: e.check_legal_docs,
          handoff_messages: cleanHandoff, automations: cleanAutos, deactivation_rules: cleanDeact,
          knowledge_base_instructions: e.knowledge_base_instructions, enabled_kbs: e.enabled_kbs,
          max_messages_per_conversation: clampNum(e.max_messages_per_conversation, 10, 200, 100), daily_proactive_limit: clampNum(e.daily_proactive_limit, 0, 100, 10), no_response_threshold: clampNum(e.no_response_threshold, 1, 20, 3), quiet_hours: e.quiet_hours,
          enable_audio_transcription: e.enable_audio_transcription, enable_image_analysis: e.enable_image_analysis, enable_pdf_reading: e.enable_pdf_reading, enable_summary_notes: e.enable_summary_notes,
          notifications: e.notifications,
          outreach_config: { ...e.outreach, enabled: enabled.has("outreach"), rate_per_hour: clampNum(e.outreach.rate_per_hour, 1, 500, 20), daily_cap: clampNum(e.outreach.daily_cap, 1, 5000, 100) },
          // Pedro 2026-05-28: 4 campos antes missing-UI / dead-write. null quando
          // vazio (schema é nullable) pra cair pro default do dispatcher.
          ai_model: e.ai_model || null,
          fallback_model: e.fallback_model || null,
          disabled_tools: e.disabled_tools.length ? e.disabled_tools : null,
          system_prompt_override: e.system_prompt_override.trim() || null,
          // F37 (Pedro 2026-05-29): memória do lead + handoff.
          lead_history_config: e.lead_history_config,
          handoff_policy: e.handoff_policy,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "falhou");
      setDirty(false);
      // Fix bug observado em prod 2026-06-08 (Alves Cury): o PUT tolera schema
      // cache stale (PGRST204) descartando a coluna faltante e devolvendo 200
      // com warnings.missing_columns. Antes a UI ignorava isso → "salvo" mentia
      // (memória do lead/handoff sumia em silêncio porque a migration 00096 não
      // tinha rodado). Agora avisa em vez de fingir sucesso.
      const missing: string[] = payload?.warnings?.missing_columns ?? [];
      if (missing.length > 0) {
        toast.error(`Salvo parcialmente — estes campos não persistiram (migration pendente no banco): ${missing.join(", ")}`);
      } else {
        toast.success("Configurações salvas");
      }
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
    // Proatividade: só o SparkBot (rep-facing). Em lead, escondido. (Antes do
    // isLead pra não vazar pra agente de lead.)
    if (id === "proactivity") return isSparkbot;
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
      {/* Header — sticky compacto (nome + status + ações sempre visíveis) */}
      <div className="cfg-hdr">
        <Link href="/hub/agents" className="btn btn--quiet btn--icon btn--sm" aria-label="Voltar para agentes" title="Voltar para agentes">
          <ChevronLeft />
        </Link>
        <AMark templateKey={detail.template_key} size="lg" />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, alignItems: "center", minWidth: 0 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-.01em", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail.name}</h1>
            <StatusBadge status={status} />
          </div>
          <div className="row wrap" style={{ gap: 10, marginTop: 3, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{TEMPLATE_LABEL[detail.template_key] || detail.template_key}</span>
            {detail.channels.map((c2) => <ChannelChip key={c2} name={c2} />)}
            <PriceBadge included={detail.included} entitled={detail.entitled} />
            {detail.since && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{detail.since}</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexShrink: 0 }}>
          <button className="btn btn--ghost btn--sm" onClick={() => setShowTest(true)} disabled={isSparkbot} title={isSparkbot ? "Teste o SparkBot direto no WhatsApp" : undefined}>
            <Play /> Testar
          </button>
          <button className="btn btn--ghost btn--sm" onClick={toggleStatus} disabled={togglingStatus || status === "blocked"}>
            {status === "active" ? <><Pause /> Pausar</> : <><Play /> Ativar</>}
          </button>
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
                  <button type="button" className="switch" role="switch" aria-checked={moduleOn} aria-label={moduleOn ? "Desligar capacidade" : "Ligar capacidade"} onClick={() => masterToggle(catMod!)} />
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
                {cat === "tone" && <CatTone e={e} patch={patch} />}
                {/* F27 (Pedro 2026-05-28): Cat "Ativação" — targeting_rules promovido pra rail. */}
                {cat === "activation" && (
                  <CatActivation
                    e={e}
                    patch={patch}
                    outreachEnabled={enabled.has("outreach")}
                    setOutreachEnabled={(on) => {
                      const next = new Set(enabled);
                      if (on) next.add("outreach");
                      else next.delete("outreach");
                      setEnabled(next);
                    }}
                  />
                )}
                {cat === "channel" && <CatChannel e={e} patch={patch} />}
                {cat === "qualification" && <CatQualification e={e} patch={patch} />}
                {cat === "scheduling" && <CatScheduling e={e} patch={patch} isRecruitment={isRecruitment} />}
                {cat === "followup" && <CatFollowup e={e} patch={patch} />}
                {cat === "outreach" && <CatOutreach e={e} patch={patch} />}
                {cat === "knowledge" && <CatKnowledge e={e} patch={patch} agentId={detail.id} />}
                {cat === "hours" && <CatHours e={e} patch={patch} />}
                {cat === "automations" && <CatAutomations e={e} patch={patch} />}
                {/* F37 (Pedro 2026-05-29): nova Cat memória do lead + handoff. */}
                {cat === "memory" && <CatMemory e={e} patch={patch} />}
                {cat === "pause" && <CatPause e={e} patch={patch} />}
                {cat === "limits" && <CatLimits e={e} patch={patch} isRep={!isLead} />}
                {cat === "proactivity" && <CatProactivity />}
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
// ─────────────────────────────────────────────────────────────────────────
// Proatividade do SparkBot — CRUD via /api/agents/sparkbot/rules.
// Eventos reactive que JÁ disparam no runtime: post_meeting. Scheduled (cron):
// todos disparam. Os demais reactive são stub/gated → marcados "em breve"
// (toggle travado pra não ligar algo que não acontece). PUT/DELETE são
// admin-only no backend, então só admin edita aqui.
// ─────────────────────────────────────────────────────────────────────────
const LIVE_REACTIVE_EVENTS = new Set<string>(["post_meeting"]);

interface ProactiveRule {
  id: string;
  rule_type: "reactive" | "scheduled";
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_config: { event?: string; cron?: string; timezone?: string };
  prompt_instruction: string;
  cooldown_minutes: number;
  source: "system" | "custom";
}

function ruleIsLive(r: ProactiveRule): boolean {
  return r.rule_type === "scheduled" || LIVE_REACTIVE_EVENTS.has(String(r.trigger_config?.event || ""));
}

function cronHuman(cron?: string): string {
  if (!cron) return "Agendado";
  const map: Record<string, string> = {
    "0 8 * * 1-5": "Dias úteis às 8h",
    "0 18 * * 1-5": "Dias úteis às 18h",
    "0 9 * * 1": "Segundas às 9h",
    "0 17 * * 5": "Sextas às 17h",
  };
  return map[cron.trim()] || `cron: ${cron}`;
}

function CatProactivity() {
  const session = useHubSession();
  const isAdmin = !!session?.isAdmin;
  const [rules, setRules] = useState<ProactiveRule[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/agents/sparkbot/rules")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((d) => { if (alive) setRules(Array.isArray(d.rules) ? d.rules : []); })
      .catch(() => { if (alive) setLoadErr(true); });
    return () => { alive = false; };
  }, []);

  async function patchRule(id: string, body: Partial<ProactiveRule>) {
    setBusy(id);
    try {
      const res = await fetch(`/api/agents/sparkbot/rules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      setRules((prev) => prev?.map((r) => (r.id === id ? { ...r, ...body } : r)) ?? prev);
      toast.success("Proatividade atualizada");
    } catch (err) {
      toast.error("Não consegui salvar: " + (err instanceof Error ? err.message : ""));
    } finally {
      setBusy(null);
    }
  }

  if (loadErr) return <div className="empty">Não consegui carregar as regras de proatividade.</div>;
  if (!rules) return <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Carregando…</div>;

  const renderRule = (r: ProactiveRule) => {
    const live = ruleIsLive(r);
    const trigger = r.rule_type === "scheduled" ? cronHuman(r.trigger_config?.cron) : "Quando acontece o evento";
    const isOpen = open === r.id;
    const canToggle = isAdmin && live && busy !== r.id;
    return (
      <div key={r.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--line-faint)" }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>{r.name}</span>
              {!live && <span className="pill pill--muted">em breve</span>}
              {r.source === "custom" && <span className="pill pill--info">custom</span>}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
              {trigger}{r.description ? ` · ${r.description}` : ""}
            </div>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={r.enabled && live}
            aria-label={`Ativar ${r.name}`}
            disabled={!canToggle}
            style={!canToggle ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            onClick={() => { if (canToggle) patchRule(r.id, { enabled: !r.enabled }); }}
          />
        </div>
        {isAdmin && live && (
          <>
            <button className="btn btn--ghost btn--sm" style={{ marginTop: 6 }} onClick={() => setOpen(isOpen ? null : r.id)}>
              {isOpen ? "Fechar" : "Editar instrução"}
            </button>
            {isOpen && (
              <div style={{ marginTop: 8 }}>
                <Field label="O que o bot faz/diz" hint="Linguagem natural. A IA gera a mensagem a partir disso.">
                  <textarea className="input" rows={3} maxLength={3000} defaultValue={r.prompt_instruction}
                    onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== r.prompt_instruction) patchRule(r.id, { prompt_instruction: v }); }} />
                </Field>
                <Field label="Cooldown (min)" hint="Tempo mínimo entre disparos do mesmo tipo.">
                  <input className="input" type="number" min={0} max={10080} defaultValue={r.cooldown_minutes} style={{ width: 120 }}
                    onBlur={(ev) => { const n = Number(ev.target.value); if (Number.isFinite(n) && n !== r.cooldown_minutes) patchRule(r.id, { cooldown_minutes: n }); }} />
                </Field>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const scheduled = rules.filter((r) => r.rule_type === "scheduled");
  const reactive = rules.filter((r) => r.rule_type === "reactive");

  return (
    <div>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        O SparkBot pode te procurar sozinho: resumos em horário fixo e alertas quando algo acontece no Spark Leads. As marcadas <strong>em breve</strong> ainda não disparam.
      </p>
      {!isAdmin && <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>Só admins ligam/editam a proatividade.</p>}

      <SubHd>Resumos agendados</SubHd>
      {scheduled.length === 0 ? <div className="muted" style={{ fontSize: 13, padding: "6px 0" }}>Nenhum resumo agendado.</div> : scheduled.map(renderRule)}

      <SubHd>Alertas reativos</SubHd>
      {reactive.length === 0 ? <div className="muted" style={{ fontSize: 13, padding: "6px 0" }}>Nenhum alerta reativo.</div> : reactive.map(renderRule)}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fstack">
      <div className="fstack__head">
        <div className="fstack__lbl">{label}</div>
        <div className="fstack__hint">{hint || " "}</div>
      </div>
      <div className="fstack__ctrl">{children}</div>
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
      <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={onChange} />
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
// Pedro 2026-05-28: ai_model + fallback_model viraram editáveis (antes ai_model
// era display read-only mas não no PUT — mentira de UI). Lista de modelos
// curada (Sonnet/Haiku/GPT-4.1) bate com o dispatcher do `llm-client.ts`.
// "padrão" = vazio = dispatcher escolhe pelo template do agente.
const AI_MODELS: { value: string; label: string }[] = [
  { value: "", label: "Padrão (gerenciado pelo Spark)" },
  { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5 (qualidade)" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (rápido)" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4.1", label: "GPT-4.1" },
];
function CatTone({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  return (
    <>
      <Field label="Personalidade" hint="Onde o agente fica em cada eixo.">
        <Sld label="Criatividade" left="Conservador" right="Criativo" value={e.tone_creativity} onChange={(v) => patch({ tone_creativity: v })} />
        <Sld label="Formalidade" left="Casual" right="Formal" value={e.tone_formality} onChange={(v) => patch({ tone_formality: v })} />
        <Sld label="Naturalidade" left="Robótico" right="Humano" value={e.tone_naturalness} onChange={(v) => patch({ tone_naturalness: v })} />
        <Sld label="Assertividade" left="Tímido" right="Direto" value={e.tone_aggressiveness} onChange={(v) => patch({ tone_aggressiveness: v })} />
      </Field>
      <Field label="Exemplos de conversa" hint="Como responder em situações comuns (opcional, mas ajuda muito)."><textarea className="textarea" rows={5} maxLength={20000} value={e.conversation_examples} onChange={(ev) => patch({ conversation_examples: ev.target.value })} placeholder={"Ex:\nLead: Quanto custa?\nAgente: Depende do perfil — me conta sua idade e cidade que eu já te dou uma ideia 😊"} /></Field>
      <div className="fgrid">
        <Field label="Modelo de IA" hint="Vazio = o Spark escolhe pelo tipo do agente.">
          <select className="select" aria-label="Modelo de IA primário" value={e.ai_model} onChange={(ev) => patch({ ai_model: ev.target.value })}>
            {AI_MODELS.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
          </select>
        </Field>
        <Field label="Modelo de fallback" hint="Quando o primário falha. Vazio = sem fallback.">
          <select className="select" aria-label="Modelo de fallback" value={e.fallback_model} onChange={(ev) => patch({ fallback_model: ev.target.value })}>
            {AI_MODELS.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
          </select>
        </Field>
      </div>
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
            <button type="button" className="switch" role="switch" aria-checked={e.channels.includes(o.k)} aria-label={CHANNEL_LABEL[o.k]} onClick={() => toggle(o.k)} />
          </label>
        ))}
      </div>
      {/* Pedro 2026-05-28 — footgun: zero canais ativos = agente mudo silencioso.
          Espelha o aviso de "nenhum dia ativo" do CatHours. extra_channels conta
          (canais preservados que o /hub não edita, ex: Email). */}
      {e.channels.length === 0 && e.extra_channels.length === 0 && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 10,
            border: "1px solid #DC2626",
            background: "#FEF2F2",
            borderRadius: "var(--r-sm)",
          }}
        >
          <strong style={{ fontSize: 13, color: "#991B1B" }}>⚠️ Nenhum canal selecionado</strong>
          <p style={{ fontSize: 12.5, margin: "4px 0 0", color: "#991B1B", lineHeight: 1.4 }}>
            Sem canal ativo, o agente não consegue responder a ninguém. Selecione pelo menos 1 canal acima.
          </p>
        </div>
      )}
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
                <button type="button" className="switch" role="switch" aria-checked={day.enabled} aria-label={`Atender ${d.label}`} onClick={() => setDay(d.key, { enabled: !day.enabled })} />
                <span style={{ width: 78, fontSize: 13, fontWeight: 500 }}>{d.label}</span>
                <input className="input" type="time" value={day.start} disabled={!day.enabled} onChange={(ev) => setDay(d.key, { start: ev.target.value })} style={{ width: 120 }} />
                <span className="muted" style={{ fontSize: 12 }}>às</span>
                <input className="input" type="time" value={day.end} disabled={!day.enabled} onChange={(ev) => setDay(d.key, { end: ev.target.value })} style={{ width: 120 }} />
              </div>
            );
          })}
        </div>
        {w.mode === "only_during" && !anyDay && (
          <div className="card card--flat" style={{ padding: 10, marginTop: 10, background: "var(--warning-soft, var(--surface-2))" }}>
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

  // F27 (Pedro 2026-05-28): targeting_rules MIGROU pra Cat "Ativação" (CatActivation
  // abaixo). CatQualification fica focado só em PERGUNTAS — o que o agente coleta.
  // "Quem o agente atende" virou Cat própria na rail (Crosshair).
  return (
    <Field label="Perguntas de qualificação" hint="O que o agente coleta para identificar um bom lead.">
      <div className="col" style={{ gap: 8 }}>
        {fields.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nenhuma pergunta configurada.</div>}
        {fields.map((f, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 130px auto auto", gap: 10, alignItems: "center", background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8 }}>
            <input className="input" value={f.label} onChange={(ev) => update(i, { label: ev.target.value })} />
            <select className="select" aria-label="Tipo do campo" value={f.type} onChange={(ev) => update(i, { type: ev.target.value as DataField["type"] })}><option value="text">Texto</option><option value="date">Data</option><option value="boolean">Sim/Não</option><option value="select">Opções</option></select>
            <label className="row" style={{ gap: 6, fontSize: 12, color: "var(--ink-3)" }}><button type="button" className="switch" role="switch" aria-checked={f.required} aria-label="Campo obrigatório" onClick={() => update(i, { required: !f.required })} /> obrig.</label>
            <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remove(i)} aria-label="Remover"><Trash2 size={13} /></button>
          </div>
        ))}
        <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start", marginTop: 2 }} onClick={add}><Plus /> Nova pergunta</button>
      </div>
    </Field>
  );
}

/* ─── Ativação (F27 + F34, Pedro 2026-05-28) ───────────────────────
 * Cat unificada: tipo de ativação no topo + editor condicional.
 *
 * 5 tipos:
 *  - inbound: agente responde quando lead manda msg (sem filtro extra)
 *  - tag: targeting_rules.tag
 *  - custom_field: targeting_rules.custom_field
 *  - pipeline_stage: targeting_rules.pipeline_stage
 *  - bulk: módulo outreach ON + outreach_config (tag_filter, rate, cap, etc)
 *
 * Detecção do tipo atual baseada em dados (sem migration):
 *  - outreach module enabled → "bulk"
 *  - targeting_rules tem entrada → tipo da 1ª regra
 *  - senão → "inbound"
 *
 * Trocar de tipo limpa o "outro lado" (rules ↔ outreach) pra evitar
 * config fantasma. Agente só pode estar em UM modo de ativação por vez. */

type ActivationType = "inbound" | "tag" | "custom_field" | "pipeline_stage" | "bulk" | "advanced";

function detectActivationType(
  rules: TargetingRules,
  outreachEnabled: boolean,
): ActivationType {
  if (outreachEnabled) return "bulk";
  // Set v2 (grupos E/OU) OU array com folha de mensagem → modo Avançado.
  if (!Array.isArray(rules)) return "advanced";
  if (rules.length === 0) return "inbound";
  if (rules.some((r) => r.type === "message")) return "advanced";
  return rules[0].type === "message" ? "advanced" : rules[0].type;
}

const ACTIVATION_CHIPS: { value: ActivationType; label: string; hint: string }[] = [
  { value: "inbound", label: "Por mensagem", hint: "Agente responde quando o lead manda uma mensagem." },
  { value: "tag", label: "Por tag", hint: "Agente atende só contatos com tag específica." },
  { value: "custom_field", label: "Por campo personalizado", hint: "Filtra por valor de custom field do Spark Leads." },
  { value: "pipeline_stage", label: "Por oportunidade (funil)", hint: "Atende quem está em estágio específico do funil." },
  { value: "bulk", label: "Por disparo em massa", hint: "Agente INICIA a conversa com uma lista. Você define ritmo e mensagem." },
  { value: "advanced", label: "Avançado (E / OU)", hint: "Combina várias condições — tag, campo, funil E conteúdo da mensagem — com grupos E (todas) e OU (qualquer)." },
];

/* ─── Editor avançado de grupos E/OU (v2, Pedro 2026-06-17) ──────────
 * Permite combinar N condições em N grupos, cada grupo com seu próprio
 * E/OU, e os grupos entre si com E/OU. Inclui a folha "message" (filtro
 * por CONTEÚDO da mensagem do lead) com operadores de texto. */

const MSG_OPS: { value: MessageMatchOp; label: string; multi?: boolean }[] = [
  { value: "contains", label: "contém a palavra" },
  { value: "not_contains", label: "NÃO contém" },
  { value: "eq", label: "é exatamente igual a" },
  { value: "starts_with", label: "começa com" },
  { value: "ends_with", label: "termina com" },
  { value: "in", label: "contém qualquer uma da lista", multi: true },
  { value: "matches_regex", label: "casa com a expressão (regex)" },
];

const COND_TYPES: { value: TargetingRule["type"]; label: string }[] = [
  { value: "message", label: "Conteúdo da mensagem" },
  { value: "tag", label: "Tag" },
  { value: "custom_field", label: "Campo personalizado" },
  { value: "pipeline_stage", label: "Etapa do funil" },
];

/** Editor de UMA folha (condição) dentro de um grupo. */
function LeafEditor({
  r,
  onChange,
  onRemove,
}: {
  r: TargetingRule;
  onChange: (p: Partial<TargetingRule>) => void;
  onRemove: () => void;
}) {
  const op = r.message_operator ?? "contains";
  const isMulti = MSG_OPS.find((o) => o.value === op)?.multi;
  return (
    <div
      className="row"
      style={{ gap: 8, alignItems: "center", background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: 8, flexWrap: "wrap" }}
    >
      {/* Tipo da condição */}
      <select
        className="input"
        style={{ width: "auto", minWidth: 160 }}
        value={r.type}
        onChange={(ev) => {
          const next = ev.target.value as TargetingRule["type"];
          // Troca de tipo limpa os campos do tipo anterior pra não vazar valor.
          onChange({
            type: next,
            tag: undefined,
            custom_field_key: undefined,
            custom_field_value: undefined,
            pipeline_id: undefined,
            pipeline_stage_id: undefined,
            message_operator: next === "message" ? "contains" : undefined,
            message_value: undefined,
            message_values: undefined,
          });
        }}
      >
        {COND_TYPES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>

      {r.type === "message" && (
        <>
          <select
            className="input"
            style={{ width: "auto", minWidth: 180 }}
            value={op}
            onChange={(ev) => {
              const nextOp = ev.target.value as MessageMatchOp;
              const nextMulti = MSG_OPS.find((o) => o.value === nextOp)?.multi;
              // Migra valor entre single ↔ lista ao trocar de operador.
              if (nextMulti) {
                onChange({ message_operator: nextOp, message_values: r.message_values ?? (r.message_value ? [r.message_value] : []), message_value: undefined });
              } else {
                onChange({ message_operator: nextOp, message_value: r.message_value ?? r.message_values?.[0] ?? "", message_values: undefined });
              }
            }}
          >
            {MSG_OPS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {isMulti ? (
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              value={(r.message_values ?? []).join(", ")}
              onChange={(ev) => onChange({ message_values: ev.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              placeholder="palavra1, palavra2, palavra3"
            />
          ) : (
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              value={r.message_value ?? ""}
              onChange={(ev) => onChange({ message_value: ev.target.value })}
              placeholder={op === "matches_regex" ? "ex: (quero|preciso).*seguro" : "ex: orçamento"}
            />
          )}
          <Toggle label="Diferenciar maiúsculas" checked={!!r.case_sensitive} onChange={() => onChange({ case_sensitive: !r.case_sensitive })} />
        </>
      )}

      {r.type === "tag" && (
        <TagPicker value={r.tag || ""} onChange={(v) => onChange({ tag: v })} placeholder="escolha a tag" />
      )}
      {r.type === "custom_field" && (
        <CustomFieldPicker
          fieldKey={r.custom_field_key || ""}
          fieldValue={r.custom_field_value || ""}
          onChange={(next) => onChange({ custom_field_key: next.custom_field_key, custom_field_value: next.custom_field_value })}
        />
      )}
      {r.type === "pipeline_stage" && (
        <PipelineStagePicker
          pipelineId={r.pipeline_id || ""}
          stageId={r.pipeline_stage_id || ""}
          onChange={(next) => onChange({ pipeline_id: next.pipeline_id, pipeline_stage_id: next.pipeline_stage_id })}
        />
      )}

      <button className="btn btn--quiet btn--icon btn--sm" onClick={onRemove} aria-label="Remover condição"><Trash2 size={13} /></button>
    </div>
  );
}

/** Editor do set v2 inteiro: grupos com E/OU + combinação entre grupos. */
function GroupsEditor({
  set,
  onChange,
}: {
  set: TargetingRuleSet;
  onChange: (next: TargetingRuleSet) => void;
}) {
  const updGroup = (gi: number, p: Partial<TargetingGroup>) =>
    onChange({ ...set, groups: set.groups.map((g, i) => (i === gi ? { ...g, ...p } : g)) });
  const addLeaf = (gi: number) =>
    updGroup(gi, { rules: [...set.groups[gi].rules, { id: rid(), type: "message", message_operator: "contains", message_value: "" }] });
  const updLeaf = (gi: number, li: number, p: Partial<TargetingRule>) =>
    updGroup(gi, { rules: set.groups[gi].rules.map((r, i) => (i === li ? { ...r, ...p } : r)) });
  const remLeaf = (gi: number, li: number) =>
    updGroup(gi, { rules: set.groups[gi].rules.filter((_, i) => i !== li) });
  const addGroup = () =>
    onChange({ ...set, groups: [...set.groups, { id: rid(), match: "all", rules: [{ id: rid(), type: "message", message_operator: "contains", message_value: "" }] }] });
  const remGroup = (gi: number) =>
    onChange({ ...set, groups: set.groups.filter((_, i) => i !== gi) });

  return (
    <div className="col" style={{ gap: 10 }}>
      {set.groups.length > 1 && (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12.5 }}>Combinar os grupos com</span>
          <Seg
            value={set.match}
            options={[{ v: "all" as const, l: "E (todos os grupos)" }, { v: "any" as const, l: "OU (qualquer grupo)" }]}
            onChange={(v) => onChange({ ...set, match: v })}
          />
        </div>
      )}

      {set.groups.map((g, gi) => (
        <div key={g.id} className="col" style={{ gap: 8, border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 10, background: "var(--surface-2)" }}>
          <div className="row" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 12.5 }}>Dentro do grupo {gi + 1}:</span>
              <Seg
                value={g.match}
                options={[{ v: "all" as const, l: "E (todas batem)" }, { v: "any" as const, l: "OU (qualquer bate)" }]}
                onChange={(v) => updGroup(gi, { match: v })}
              />
            </div>
            {set.groups.length > 1 && (
              <button className="btn btn--quiet btn--sm" onClick={() => remGroup(gi)}>
                <Trash2 size={13} /> Remover grupo
              </button>
            )}
          </div>

          {g.rules.map((r, li) => (
            <LeafEditor
              key={r.id}
              r={r}
              onChange={(p) => updLeaf(gi, li, p)}
              onRemove={() => remLeaf(gi, li)}
            />
          ))}

          <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => addLeaf(gi)}>
            <Plus /> Adicionar condição
          </button>
        </div>
      ))}

      <button className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={addGroup}>
        <Plus /> Adicionar grupo
      </button>
    </div>
  );
}

function CatActivation({
  e,
  patch,
  outreachEnabled,
  setOutreachEnabled,
}: {
  e: Editable;
  patch: (p: Partial<Editable>) => void;
  outreachEnabled: boolean;
  setOutreachEnabled: (on: boolean) => void;
}) {
  const tr = e.targeting_rules;
  const type = detectActivationType(tr, outreachEnabled);
  // Modos simples (tag/custom_field/pipeline_stage/inbound) operam num array
  // flat. Modo avançado opera num set v2 com grupos E/OU.
  const flat: TargetingRule[] = Array.isArray(tr) ? tr : [];
  const ruleSet: TargetingRuleSet | null = !Array.isArray(tr) ? tr : null;
  // Array legado com folha "message" também cai no editor avançado: embrulha
  // num set v2 transitório (1 grupo "all" = AND). Ao 1º edit vira set de fato.
  const advSet: TargetingRuleSet =
    ruleSet ?? { version: 2, match: "all", groups: [{ id: "g0", match: "all", rules: flat }] };

  const switchType = (next: ActivationType) => {
    if (next === type) return;
    if (next === "bulk") {
      // Bulk = ativação por disparo; limpa targeting_rules (incompatível)
      // e liga módulo outreach. Conserva e.outreach.* atuais (config).
      patch({ targeting_rules: [] });
      setOutreachEnabled(true);
    } else if (next === "inbound") {
      patch({ targeting_rules: [] });
      setOutreachEnabled(false);
    } else if (next === "advanced") {
      // Semeia o set v2 a partir das regras simples atuais (1 grupo "all" =
      // mesma semântica AND do legado). Sem regras → 1 folha message vazia.
      const seedRules: TargetingRule[] =
        flat.length > 0
          ? flat
          : [{ id: rid(), type: "message", message_operator: "contains", message_value: "" }];
      patch({ targeting_rules: { version: 2, match: "all", groups: [{ id: rid(), match: "all", rules: seedRules }] } });
      setOutreachEnabled(false);
    } else {
      // tag / custom_field / pipeline_stage: limpa outreach, semeia 1 regra
      // do tipo escolhido se ainda não tem nenhuma daquele tipo. Vem do set
      // v2? achata pras folhas do tipo escolhido.
      const source = ruleSet ? ruleSet.groups.flatMap((g) => g.rules) : flat;
      const hasOfType = source.some((r) => r.type === next);
      const newRules = hasOfType
        ? source.filter((r) => r.type === next) // só mantém as do tipo escolhido
        : [{ id: rid(), type: next } as TargetingRule];
      patch({ targeting_rules: newRules });
      setOutreachEnabled(false);
    }
  };

  const addT = (forType: TargetingRule["type"]) =>
    patch({ targeting_rules: [...flat, { id: rid(), type: forType }] });
  const updT = (i: number, p: Partial<TargetingRule>) =>
    patch({ targeting_rules: flat.map((r, idx) => (idx === i ? { ...r, ...p } : r)) });
  const remT = (i: number) => patch({ targeting_rules: flat.filter((_, idx) => idx !== i) });

  const setOutreach = (p: Partial<Outreach>) =>
    patch({ outreach: { ...e.outreach, ...p } });

  return (
    <>
      <Field
        label="Tipo de ativação"
        hint="Define COMO o agente é acionado. Só um tipo por vez."
      >
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {ACTIVATION_CHIPS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => switchType(c.value)}
                aria-pressed={type === c.value}
                className={type === c.value ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
                style={{ minWidth: 100 }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {ACTIVATION_CHIPS.find((c) => c.value === type)?.hint}
          </div>
        </div>
      </Field>

      {/* Sub-editor por tipo */}
      {type === "inbound" && (
        <div
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            padding: 12,
            fontSize: 13,
            color: "var(--ink-3)",
            lineHeight: 1.5,
          }}
        >
          Esse agente responde a <strong>qualquer mensagem</strong> que chegar
          na sub-conta (sem filtro extra). Se quiser restringir, troca o tipo
          acima.
        </div>
      )}

      {(type === "tag" || type === "custom_field" || type === "pipeline_stage") && (
        <Field
          label={
            type === "tag"
              ? "Tags que ativam"
              : type === "custom_field"
                ? "Campos personalizados que ativam"
                : "Etapas do funil que ativam"
          }
          hint="Combinação AND — o contato precisa bater em TODAS as regras pro agente atender."
        >
          <div className="col" style={{ gap: 8 }}>
            {flat.length === 0 && (
              <div
                style={{
                  background: "#fef3c7",
                  border: "1px solid #f59e0b",
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 13,
                  color: "#78350f",
                  lineHeight: 1.5,
                }}
              >
                ⚠️ <strong>Sem filtros configurados.</strong> Sem nenhuma regra, esse modo
                fica equivalente a &ldquo;Por mensagem&rdquo; — agente responde QUALQUER contato.
                Adicione pelo menos 1 regra abaixo OU troca pra &ldquo;Por mensagem&rdquo; no topo.
              </div>
            )}
            {flat.map((r, i) =>
              r.type !== type ? null : (
                <div key={r.id} className="row" style={{ gap: 8, alignItems: "center", background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8, flexWrap: "wrap" }}>
                  {/* F35: pickers dinâmicos puxam de /api/ghl/{tags,pipelines,custom-fields}. Fallback pra input se API offline. */}
                  {type === "tag" && (
                    <TagPicker
                      value={r.tag || ""}
                      onChange={(v) => updT(i, { tag: v })}
                      placeholder="escolha a tag"
                    />
                  )}
                  {type === "custom_field" && (
                    <CustomFieldPicker
                      fieldKey={r.custom_field_key || ""}
                      fieldValue={r.custom_field_value || ""}
                      onChange={(next) => updT(i, { custom_field_key: next.custom_field_key, custom_field_value: next.custom_field_value })}
                    />
                  )}
                  {type === "pipeline_stage" && (
                    <PipelineStagePicker
                      pipelineId={r.pipeline_id || ""}
                      stageId={r.pipeline_stage_id || ""}
                      onChange={(next) => updT(i, { pipeline_id: next.pipeline_id, pipeline_stage_id: next.pipeline_stage_id })}
                    />
                  )}
                  <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remT(i)} aria-label="Remover"><Trash2 size={13} /></button>
                </div>
              ),
            )}
            <button
              className="btn btn--ghost btn--sm"
              style={{ alignSelf: "flex-start", marginTop: 2 }}
              onClick={() => addT(type)}
            >
              <Plus /> Adicionar {type === "tag" ? "tag" : type === "custom_field" ? "campo" : "etapa"}
            </button>
          </div>
        </Field>
      )}

      {type === "bulk" && (
        <>
          <Field label="Quem o agente aborda" hint="Contatos com estas tags (escolha do Spark Leads).">
            {/* F35: TagsMultiPicker em vez de input comma-separated. */}
            <TagsMultiPicker
              values={e.outreach.tag_filter.tags}
              onChange={(next) => setOutreach({ tag_filter: { ...e.outreach.tag_filter, tags: next } })}
            />
            <div style={{ marginTop: 8 }}>
              <Seg
                value={e.outreach.tag_filter.match}
                options={[{ v: "any" as const, l: "Qualquer uma das tags" }, { v: "all" as const, l: "Todas as tags" }]}
                onChange={(v) => setOutreach({ tag_filter: { ...e.outreach.tag_filter, match: v } })}
              />
            </div>
          </Field>
          <SubHd>Ritmo de envio</SubHd>
          <div className="fgrid">
            <Field label="Quantas pessoas por dia" hint="Cap diário — o agente não aborda mais que isso.">
              <input className="input" type="number" min={1} max={5000} value={e.outreach.daily_cap} onChange={(ev) => setOutreach({ daily_cap: Number(ev.target.value) })} />
            </Field>
            <Field label="Velocidade (por hora)" hint="Espalha no tempo, sem rajada.">
              <input className="input" type="number" min={1} max={500} value={e.outreach.rate_per_hour} onChange={(ev) => setOutreach({ rate_per_hour: Number(ev.target.value) })} />
            </Field>
          </div>
          <Field label="Horário" hint="Quando ligado, respeita horário de atendimento + quiet hours (F32).">
            <Toggle label="Só dentro do horário de atendimento" checked={e.outreach.respect_working_hours} onChange={() => setOutreach({ respect_working_hours: !e.outreach.respect_working_hours })} />
          </Field>
          <div className="card card--flat" style={{ padding: 12, background: "var(--primary-soft)", margin: "4px 0 4px" }}>
            <span style={{ fontSize: 12.5, color: "var(--primary-ink)" }}>
              📋 Aborda até <strong>{e.outreach.daily_cap} pessoas/dia</strong>, no ritmo de ~{e.outreach.rate_per_hour}/hora,{" "}
              {e.outreach.respect_working_hours ? "dentro do horário de atendimento" : "a qualquer hora do dia"}.
            </span>
          </div>
          <Field label="Mensagem de abertura" hint="A 1ª mensagem que o agente manda. Vazio = a IA cria com base no propósito.">
            <textarea
              className="textarea"
              rows={3}
              value={e.outreach.opening_message}
              onChange={(ev) => setOutreach({ opening_message: ev.target.value })}
              placeholder="Ex: Oi {first_name}! Vi que você passou no nosso feirão — posso te ajudar?"
            />
          </Field>
          <div className="card card--flat" style={{ padding: 12, background: "var(--surface-2)", marginTop: 4 }}>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              Depois de iniciar, o agente <strong>conduz</strong> a conversa normalmente (qualifica, agenda…). O disparo real é liberado pela agência (supervisionado) antes de ligar em produção.
            </span>
          </div>
        </>
      )}

      {type === "advanced" && (
        <Field
          label="Condições de ativação (E / OU)"
          hint="Monte grupos de condições. Dentro de cada grupo escolha E (todas batem) ou OU (qualquer bate); e como combinar os grupos entre si."
        >
          <div className="col" style={{ gap: 10 }}>
            <div
              style={{
                background: "var(--primary-soft)",
                borderRadius: "var(--r-sm)",
                padding: 10,
                fontSize: 12.5,
                color: "var(--primary-ink)",
                lineHeight: 1.5,
              }}
            >
              💡 A condição <strong>Conteúdo da mensagem</strong> é um <strong>gatilho de
              ENTRADA</strong>: vale no 1º contato pra DECIDIR se o agente entra na conversa. Depois
              que ele já respondeu uma vez, ela é ignorada e o agente segue o papo normalmente (não
              fica re-checando a frase em cada resposta do lead). As condições de <strong>perfil</strong>
              (tag/campo/funil) continuam valendo a conversa toda. Ex.: grupo 1 = tag &ldquo;VIP&rdquo;
              + grupo 2 = mensagem contém &ldquo;orçamento&rdquo;, com <strong>E</strong> → entra só pra
              VIP que falou em orçamento, e a partir daí conduz tudo.
            </div>
            <GroupsEditor set={advSet} onChange={(next) => patch({ targeting_rules: next })} />
          </div>
        </Field>
      )}
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
      <select className="select" aria-label="Unidade de tempo" value={unit} onChange={(ev) => onChange(Math.max(1, Math.round(val * mult(ev.target.value))))} style={{ width: 104 }}>
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
  // Calendários da location (Spark Leads) pra escolher onde o agente marca.
  // Fix C2-1 (ultra-review 2026-05-26): antes era placeholder "em breve" e o
  // calendar_id NUNCA era setado pelo hub → book_appointment caía com calendário
  // vazio (agendamento quebrado). Agora busca de /api/ghl/calendars e persiste.
  const [cals, setCals] = useState<{ id: string; name: string }[]>([]);
  const [calsLoading, setCalsLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch("/api/ghl/calendars")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const list = Array.isArray(d?.calendars)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? d.calendars.map((c: any) => ({ id: String(c?.id ?? c?.calendarId ?? c?.value ?? ""), name: String(c?.name ?? c?.calendarName ?? "Calendário") })).filter((c: { id: string }) => c.id)
          : [];
        setCals(list);
      })
      .catch(() => { /* mantém vazio → mostra aviso */ })
      .finally(() => { if (alive) setCalsLoading(false); });
    return () => { alive = false; };
  }, []);
  // Preserva o calendar_id já salvo mesmo se a lista falhar/não incluir (não limpa sem querer).
  const opts = cals.slice();
  if (e.calendar_id && !opts.some((c) => c.id === e.calendar_id)) {
    opts.unshift({ id: e.calendar_id, name: `Calendário atual (${e.calendar_id.slice(0, 8)}…)` });
  }
  return (
    <>
      <Field label="Calendário" hint="Onde o agente marca as reuniões. Sem calendário, ele só qualifica (não agenda).">
        {calsLoading ? (
          <span className="muted" style={{ fontSize: 13 }}>Carregando calendários do Spark Leads…</span>
        ) : opts.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Nenhum calendário encontrado nesta conta do Spark Leads. Crie um lá e recarregue a página.</span>
        ) : (
          <select className="select" aria-label="Calendário para agendamento" value={e.calendar_id || ""} onChange={(ev) => patch({ calendar_id: ev.target.value })} style={{ maxWidth: 420 }}>
            <option value="">— Não agendar (só qualificar)</option>
            {opts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </Field>
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

/* ─── Memória do lead + Handoff (F37, Pedro 2026-05-29) ─────────────
 * Toggle pra carregar histórico do contato no Spark Leads (msgs antigas,
 * notas, opp stage, tags) antes de responder + regras de handoff
 * (quando o bot deve SILENCIAR em vez de responder e notificar o rep
 * humano via SparkBot). Default tudo OFF — opt-in por agente.
 */
function CatMemory({ e, patch }: { e: Editable; patch: (p: Partial<Editable>) => void }) {
  const lh = e.lead_history_config;
  const hp = e.handoff_policy;
  const setLH = (p: Partial<typeof lh>) => patch({ lead_history_config: { ...lh, ...p } });
  const setHP = (p: Partial<typeof hp>) => patch({ handoff_policy: { ...hp, ...p } });

  return (
    <>
      <div
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-md)",
          padding: 12,
          marginBottom: 14,
          fontSize: 13,
          color: "var(--ink-3)",
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: "var(--ink)" }}>Como funciona:</strong> quando ligado, o agente
        consulta o histórico do contato no Spark Leads antes de responder — assim ele sabe
        em que ponto a conversa parou e não pergunta coisas já respondidas. Também pode
        decidir <em>não responder</em> em certas situações e te avisar via SparkBot.
      </div>

      <SubHd>Carregar histórico do Spark Leads</SubHd>
      <Field
        label="Ler conversas e dados antigos do contato"
        hint="Bot consulta msgs anteriores, notas, oportunidades e tags do contato antes de gerar a resposta. Adiciona ~1s de latência por turno e ~2k tokens de prompt."
      >
        <Toggle
          label="Ligado"
          checked={lh.enabled}
          onChange={() => setLH({ enabled: !lh.enabled })}
        />
      </Field>

      {lh.enabled && (
        <>
          <div className="fgrid">
            <Field label="Quantas mensagens trazer" hint="Entre 10 e 50. Padrão 20.">
              <input
                className="input"
                type="number"
                min={10}
                max={50}
                value={lh.messages_count}
                onChange={(ev) => setLH({ messages_count: Math.max(10, Math.min(50, Number(ev.target.value) || 20)) })}
              />
            </Field>
          </div>
          <Field label="O que mais incluir" hint="Quanto mais contexto, mais tokens.">
            <div className="col" style={{ gap: 8 }}>
              <Toggle label="Notas do contato (5 mais recentes)" checked={lh.include_notes} onChange={() => setLH({ include_notes: !lh.include_notes })} />
              <Toggle label="Oportunidades + estágio do funil" checked={lh.include_opportunities} onChange={() => setLH({ include_opportunities: !lh.include_opportunities })} />
              <Toggle label="Tags do contato" checked={lh.include_tags} onChange={() => setLH({ include_tags: !lh.include_tags })} />
            </div>
          </Field>
        </>
      )}

      <SubHd>Handoff inteligente</SubHd>
      <Field
        label="Decidir quando NÃO responder e notificar você"
        hint="Quando ligado, o bot avalia regras e pode silenciar (em vez de responder), te mandando uma notificação via SparkBot."
      >
        <Toggle
          label="Ligado"
          checked={hp.enabled}
          onChange={() => setHP({ enabled: !hp.enabled })}
        />
      </Field>

      {hp.enabled && (
        <>
          <Field label="Não responder se rep respondeu recentemente">
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Se você respondeu nos últimos</span>
              <input
                className="input"
                type="number"
                min={0}
                max={1440}
                value={hp.skip_if_human_replied_within_minutes}
                onChange={(ev) => setHP({ skip_if_human_replied_within_minutes: Math.max(0, Math.min(1440, Number(ev.target.value) || 0)) })}
                style={{ width: 84 }}
              />
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>minutos, bot silencia</span>
            </div>
          </Field>
          <Field label="Lead pediu humano">
            <Toggle
              label="Bot detecta e silencia + notifica"
              checked={hp.skip_if_lead_requested_human}
              onChange={() => setHP({ skip_if_lead_requested_human: !hp.skip_if_lead_requested_human })}
            />
          </Field>
          <Field label="Palavras-chave que disparam handoff" hint="Separe por vírgula. Match em qualquer parte da msg, sem acento.">
            <textarea
              className="textarea"
              rows={2}
              value={hp.custom_keywords_handoff.join(", ")}
              onChange={(ev) => setHP({ custom_keywords_handoff: ev.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              placeholder="humano, atendente, pessoa, falar com alguem"
            />
          </Field>
          <Field label="Oportunidade fechada (won/lost)">
            <Toggle
              label="Bot silencia se contato tem opp fechada"
              checked={hp.notify_on_opp_stage_closed}
              onChange={() => setHP({ notify_on_opp_stage_closed: !hp.notify_on_opp_stage_closed })}
            />
          </Field>
          <Field label="Avisar você via SparkBot quando silenciar" hint="Você recebe msg no WhatsApp com contexto do que o lead falou.">
            <Toggle
              label="Ligado"
              checked={hp.notify_rep_via_sparkbot}
              onChange={() => setHP({ notify_rep_via_sparkbot: !hp.notify_rep_via_sparkbot })}
            />
          </Field>
        </>
      )}
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
      {/* Pedro 2026-05-28 — footgun da prospecção: tags vazias OU respect_hours+hours
          desligado = nunca dispara silenciosamente. Espelha o aviso de CatChannel/CatHours. */}
      {(() => {
        const noTags = o.tag_filter.tags.length === 0;
        const noHours = o.respect_working_hours && !e.working_hours.enabled;
        if (!noTags && !noHours) return null;
        return (
          <div
            role="alert"
            style={{
              marginTop: 10,
              padding: 10,
              border: "1px solid #DC2626",
              background: "#FEF2F2",
              borderRadius: "var(--r-sm)",
            }}
          >
            <strong style={{ fontSize: 13, color: "#991B1B" }}>⚠️ A prospecção não vai disparar</strong>
            <ul style={{ fontSize: 12.5, margin: "4px 0 0 14px", padding: 0, color: "#991B1B", lineHeight: 1.5 }}>
              {noTags && <li>Sem tags definidas — adicione pelo menos uma acima.</li>}
              {noHours && (
                <li>
                  &quot;Só dentro do horário&quot; está ligado, mas a aba <strong>Atendimento</strong> está desligada — o agente nunca encontra janela. Desligue um dos dois.
                </li>
              )}
            </ul>
          </div>
        );
      })()}
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
                <button type="button" className="switch" role="switch" aria-checked={on} aria-label={kb.l} onClick={() => toggleKb(kb.v)} />
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
                <select className="select" aria-label="Evento que dispara a automação" value={ev} onChange={(evt) => setTrigger(i, evt.target.value)} style={{ width: 200 }}>
                  {EVENT_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                  <option value="__field__">Campo preenchido…</option>
                </select>
                {isField && a.trigger?.kind === "on_data_field_set" && (<>
                  <input className="input" value={a.trigger.field_key} onChange={(evt) => upd(i, { trigger: { ...a.trigger as Extract<AutomationRule["trigger"], { kind: "on_data_field_set" }>, field_key: evt.target.value } })} placeholder="chave do campo" style={{ width: 150 }} />
                  <select className="select" aria-label="Operador da condição" value={a.trigger.operator} onChange={(evt) => upd(i, { trigger: { ...a.trigger as Extract<AutomationRule["trigger"], { kind: "on_data_field_set" }>, operator: evt.target.value as "any_value" | "equals" | "contains" | "matches_regex" } })} style={{ width: 140 }}>
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
          <select className="select" aria-label="Ação da automação" value={a.type} onChange={(ev) => upd(i, { type: ev.target.value as AutomationAction["type"] })} style={{ width: 170 }}>
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
          {a.type === "pause_ai" && <input className="input" type="number" min={0} max={10080} step={1} value={a.pause_minutes ?? 0} onChange={(ev) => upd(i, { pause_minutes: Math.max(0, Math.min(10080, Math.round(Number(ev.target.value) || 0))) })} placeholder="min (0=indef.)" style={{ width: 130 }} />}
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
                  <button type="button" className="switch" role="switch" aria-checked={m.auto_deactivate} aria-label="Pausar a IA ao enviar" onClick={() => updH(i, { auto_deactivate: !m.auto_deactivate })} /> Pausar a IA ao enviar
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
            {/* Pedro 2026-05-28 — hint sobre footgun do "sempre". */}
            {([
              ["always", "Sempre — antes de qualquer ação", "Cada send/note/task pede ok do rep. Pode deixar o agente lento e passivo."],
              ["medium_and_high", "Em ações importantes (recomendado)", "Pede só nas ações de risco médio/alto (delete, send em massa)."],
              ["high_only", "Só nas mais sensíveis", "Só nas ações de risco alto."],
            ] as [ConfMode, string, string][]).map(([v, l, h]) => (
              <label key={v} className="row" style={{ gap: 10, fontSize: 13.5, cursor: "pointer", alignItems: "flex-start" }}>
                <input type="radio" name="conf" checked={e.confirmation_mode === v} onChange={() => patch({ confirmation_mode: v })} style={{ marginTop: 3 }} />
                <span>
                  {l}
                  <span className="muted" style={{ fontSize: 12, display: "block", marginTop: 2 }}>{h}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
      )}
      <div className="fgrid">
        <Field label="Espera antes de responder" hint="Segundos — agrupa mensagens em sequência."><input className="input" type="number" min={5} max={60} value={e.debounce_seconds} onChange={(ev) => patch({ debounce_seconds: Number(ev.target.value) })} /></Field>
        {/* F28: agora É aplicado pelo runtime (queue-processor pausa o agente ao
            atingir o cap). Label "em breve" + comentário de dead-write removidos
            (review 2026-06-09). */}
        <Field label="Máx. mensagens por conversa" hint="Bot pausa a conversa ao atingir esse total."><input className="input" type="number" min={10} max={200} value={e.max_messages_per_conversation} onChange={(ev) => patch({ max_messages_per_conversation: Number(ev.target.value) })} /></Field>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Quando o bot para e devolve a conversa pra uma pessoa fica na aba <strong>Pausa do bot</strong>.</p>
      {isRep && (
        <>
          <div className="fgrid" style={{ marginTop: 6 }}>
            <Field label="Proativos por dia" hint="Quantas vezes inicia conversa."><input className="input" type="number" min={0} max={100} value={e.daily_proactive_limit} onChange={(ev) => patch({ daily_proactive_limit: Number(ev.target.value) })} /></Field>
          </div>
          <Field label="Horário de silêncio" hint="Não envia nesse intervalo.">
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="switch" role="switch" aria-checked={q.enabled} aria-label="Horário de silêncio" onClick={() => setQ({ enabled: !q.enabled })} />
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

      {/* Avançado (Pedro 2026-05-28) — 4 campos antes missing-UI: disabled_tools
          + system_prompt_override (auditoria de gaps). Só pra non-rep (admin)
          pra reduzir footgun. disabled_tools usa CSV simples no input — multi-select
          chip exigiria enumerar as 38 tools, deixei pragmático. */}
      {!isRep && (
        <>
          <SubHd>Avançado (modo treinamento)</SubHd>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
            Configurações sensíveis. Use só pra experimentar — pode quebrar o agente. Reverte deixando os campos vazios.
          </p>
          <Field label="Ferramentas desabilitadas" hint="Nome das tools separados por vírgula. Vazio = todas habilitadas.">
            <input
              className="input"
              aria-label="Tools desabilitadas (CSV)"
              value={e.disabled_tools.join(", ")}
              onChange={(ev) => patch({ disabled_tools: ev.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              placeholder="ex: delete_contact, archive_conversation"
            />
          </Field>
          <Field label="Override do prompt de sistema" hint="Substitui o prompt-base inteiro. Vazio = o Spark monta o prompt automaticamente.">
            <textarea
              className="textarea"
              aria-label="System prompt override"
              rows={6}
              maxLength={20000}
              value={e.system_prompt_override}
              onChange={(ev) => patch({ system_prompt_override: ev.target.value })}
              placeholder="Vazio = padrão do Spark (recomendado)."
            />
          </Field>
        </>
      )}

      {/* F29 (Pedro 2026-05-28): toggles dead removidos.
          C2-3 do ultra-review marcou on_qualified/on_booked/on_handed_off/
          notification_email como dead-write (UI gravava, runtime nunca enviava
          email). Agora removidos da UI. on_error fica — esse funciona via
          notify.ts pra erros críticos. Re-introduzir só quando ligarmos
          infra de email (Resend/SMTP). Zod tolera campos antigos no PUT
          (silenciosamente preserva, sem usar). */}
      <SubHd>Avisos por email</SubHd>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>
        Por enquanto só enviamos avisos de erros críticos pra equipe técnica. Para acompanhar leads, use a aba Mensagens.
      </p>

      {!isRep && (
        <>
          <SubHd>Desativar o agente automaticamente</SubHd>
          <Field label="Regras de parada" hint="Quando isto acontecer, a IA para de responder aquele lead.">
            <div className="col" style={{ gap: 8 }}>
              {dr.map((r, i) => (
                <div key={r.id} className="row" style={{ gap: 8, alignItems: "center", background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8, flexWrap: "wrap" }}>
                  <select className="select" aria-label="Tipo de regra de desativação" value={r.type} onChange={(ev) => updD(i, { type: ev.target.value as DeactivationRule["type"] })} style={{ width: 170 }}>
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
