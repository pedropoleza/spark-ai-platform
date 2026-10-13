/**
 * Montagem do payload do "Salvar" do painel do agente (PUT /api/agents/[id]/config).
 *
 * Saiu de dentro do agent-detail-view.tsx (2026-10-13) sem mudar a lógica, pra
 * poder ser testada contra a config REAL de todos os agentes
 * (`scripts/test-salvar-config-agentes.ts`). Foi exatamente aqui que o painel
 * apagou config em silêncio duas vezes (H72 `require_contact_before_booking`,
 * H83 `alerta_whatsapp`) e travou o save de quem tinha instrução > 8000 chars ou
 * regra de desligamento sem id. Mexeu aqui, roda o teste.
 *
 * Puro: sem React, sem rede.
 */
import { channelsFromDb, channelsToDb, nonUiChannels, type ChannelKey } from "@/components/hub/types";
import type {
  DataField, FollowUpConfig, WorkingHoursConfig, TargetingRule, TargetingRules,
  AutomationRule, DeactivationRule, HandoffMessage,
} from "@/types/agent";

export type ConfMode = "always" | "medium_and_high" | "high_only";
export type Objective = "qualification_only" | "qualification_and_booking" | "booking_only";

export const num = (v: unknown, d: number) => (typeof v === "number" && !isNaN(v) ? v : d);
// Clamp pra faixa do schema — legado fora da faixa derrubava o PUT inteiro (400).
export const clampNum = (v: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, num(v, d)));
export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);
/** Garante `id` em cada item (mesmo formato do `rid` do painel). */
function comId<T extends { id?: string }>(itens: T[]): T[] {
  return itens.map((it) => (it?.id ? it : { ...it, id: Math.random().toString(36).slice(2, 10) }));
}

/** Uma folha de targeting só "conta" se tiver valor preenchido — senão é regra
 *  fantasma (UI semeia regra vazia ao clicar "+"). Limpamos no save pra não
 *  persistir lixo que o runtime trataria como neutro/ruidoso. */
export function isCompleteLeaf(r: TargetingRule): boolean {
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
    case "attribution":
      // is_set/not_set não têm valor — a folha já está completa com o operador.
      if (r.attribution_operator === "is_set" || r.attribution_operator === "not_set") return true;
      return r.attribution_operator === "in"
        ? !!r.attribution_values?.some((v) => v.trim())
        : !!r.attribution_value?.trim();
    default:
      return false;
  }
}

/** Remove folhas incompletas e grupos vazios antes de salvar. Aceita array
 *  legado (filtra folhas) ou set v2 (filtra folhas + drop grupos sem regra). */
export function cleanTargetingRules(tr: TargetingRules): TargetingRules {
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

export interface Quiet { enabled: boolean; start: string; end: string; timezone?: string; days?: number[] }
// `require_contact_before_booking` (caso Marina) não tem controle na UI, mas
// PRECISA sobreviver ao save: o PUT manda `post_booking` inteiro, então uma
// chave ausente do seed apagava a config no banco.
// Fix bug observado em prod 2026-08-06 (caso Richify): sem isso, o cliente abrir
// o painel e salvar qualquer coisa desligava o gate de "pedir telefone antes de
// agendar" em silêncio.
export interface PostBooking { behavior: "stop_and_handoff" | "continue_until_appointment"; handoff_message: string; allow_reschedule: boolean; require_contact_before_booking?: boolean }
export interface Notif { on_qualified: boolean; on_booked: boolean; on_handed_off: boolean; on_error: boolean; notification_email: string; alerta_whatsapp?: { enabled?: boolean; phone?: string; motivos?: string[] } }
export interface Outreach { tag_filter: { tags: string[]; match: "any" | "all" }; rate_per_hour: number; daily_cap: number; respect_working_hours: boolean; opening_message: string }

export interface Editable {
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
export function makeSeed(c: Record<string, any>): Editable {
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
    post_booking: { behavior: pb.behavior === "continue_until_appointment" ? "continue_until_appointment" : "stop_and_handoff", handoff_message: str(pb.handoff_message), allow_reschedule: bool(pb.allow_reschedule, true), require_contact_before_booking: pb.require_contact_before_booking === true },
    specialist_name: str(c.specialist_name),
    preferred_time_slot: str(c.preferred_time_slot),
    calendar_id: str(c.calendar_id),
    check_legal_docs: bool(c.check_legal_docs),
    // comId: item criado por script/SQL vem sem id, e o painel edita e remove
    // POR id — dois itens sem id seriam o "mesmo" item (fix 2026-10-13).
    handoff_messages: Array.isArray(c.handoff_messages) ? comId(c.handoff_messages as HandoffMessage[]) : [],
    automations: Array.isArray(c.automations) ? comId(c.automations as AutomationRule[]) : [],
    deactivation_rules: Array.isArray(c.deactivation_rules) ? comId(c.deactivation_rules as DeactivationRule[]) : [],
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
    // H83: `alerta_whatsapp` PRECISA ser carregado aqui. Este normalizador
    // reconstrói `notifications` campo a campo e a rota persiste o objeto
    // inteiro — uma chave ausente aqui é uma chave APAGADA no banco no primeiro
    // save do painel. Foi assim que o require_contact_before_booking sumiu (H72).
    notifications: { on_qualified: bool(nt.on_qualified, true), on_booked: bool(nt.on_booked, true), on_handed_off: bool(nt.on_handed_off, false), on_error: bool(nt.on_error, true), notification_email: str(nt.notification_email), alerta_whatsapp: nt.alerta_whatsapp },
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
      // H85 sem controle no painel: carrega só se existir (default do runtime é
      // false). Fix bug observado em prod 2026-10-13: ausente aqui, salvar o
      // "Pós-Atendimento Marina" desligava o aviso de handoff em silêncio — a
      // mesma classe do H72/H83.
      ...(typeof (c.handoff_policy as Record<string, unknown> | null)?.notify_rep_on_llm_handoff === "boolean"
        ? { notify_rep_on_llm_handoff: (c.handoff_policy as { notify_rep_on_llm_handoff: boolean }).notify_rep_on_llm_handoff }
        : {}),
    },
  };
}

/** Corpo do PUT. `enabled` = módulos ligados (fonte única dos flags on/off). */
export function buildConfigPayload(e: Editable, enabled: Set<string>) {
  // Filtra entradas incompletas pra não falhar a validação do PUT inteiro.
  const cleanTargeting = cleanTargetingRules(e.targeting_rules);
  const cleanHandoff = e.handoff_messages.filter((h) => h.label.trim() && h.text.trim());
  const cleanDeact = e.deactivation_rules.filter((d) => d.tag || d.field_key);
  const cleanAutos = e.automations.filter((a) => a.actions.length > 0);
  return {
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
  };
}
