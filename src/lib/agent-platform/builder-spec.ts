/**
 * Builder de agente custom (Plataforma Modular — Fase F, repensado 2026-05-26).
 *
 * O fluxo de criação é um WIZARD GUIADO (agent-wizard.tsx) que coleta as
 * decisões estruturais (intake, canal, identidade, objetivo, agendamento,
 * follow-up, horário) e usa a IA só pra ENRIQUECER o conteúdo "mole"
 * (instruções, campos de qualificação, tom) via /builder/compose. Aqui ficam:
 *  - AgentSpecSchema (zod) — contrato COMPLETO do agente (valida o que vem).
 *  - INTAKE: como os leads chegam (inbound / tag / etapa / palavra-chave /
 *    prospecção) → mapeado pro runtime real (targeting_rules + outreach_config).
 *  - specToConfig() — spec → agent_configs + module_keys (deriva os módulos das
 *    escolhas). O agente nasce pausado pra revisão.
 *  - proposeAgentTool()/buildBuilderSystemPrompt() — mantidos pro modo conversa
 *    (retrocompat); o wizard usa /compose + /commit.
 */
import { z } from "zod";
import type { ToolDefinition } from "@/types/account-assistant";
import type { CommunicationChannel, DataField, TargetingRule } from "@/types/agent";

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));
const rid = () => Math.random().toString(36).slice(2, 10);

const ToneSchema = z.object({
  creativity: z.number().default(60),
  formality: z.number().default(50),
  naturalness: z.number().default(80),
  assertiveness: z.number().default(50),
});
const TONE_DEFAULT = { creativity: 60, formality: 50, naturalness: 80, assertiveness: 50 };

const QualFieldSchema = z.object({
  label: z.string().min(1).max(120),
  type: z.enum(["text", "date", "boolean", "select"]).default("text"),
  required: z.boolean().default(false),
});

// INTAKE — como os leads chegam até o agente. Mapeia pro runtime:
//  inbound  → responde a qualquer mensagem nova no canal (sem targeting = fallback).
//  tag      → responde só a contatos com a(s) tag(s) (targeting_rules).
//  stage    → responde só a contatos numa etapa do funil (targeting_rules).
//  keyword  → campanha: o lead manda uma palavra-chave; contexto vai pras instruções.
//  outreach → o agente INICIA a conversa com uma lista (por tag) — outreach_config.
// Filtros extras de targeting do wizard (Pedro 2026-05-28). Espelha a UI do
// detail-view (linhas 768-792 de agent-detail-view.tsx) — mesma forma do
// TargetingRule em @/types/agent. Mescla em targeting_rules junto com o
// derivado do mode (AND).
const AdvancedTargetingRuleSchema = z.object({
  id: z.string(),
  type: z.enum(["tag", "custom_field", "pipeline_stage"]),
  tag: z.string().max(200).optional(),
  custom_field_key: z.string().max(200).optional(),
  custom_field_value: z.string().max(500).optional(),
  pipeline_id: z.string().max(200).optional(),
  pipeline_stage_id: z.string().max(200).optional(),
});

const IntakeSchema = z
  .object({
    mode: z.enum(["inbound", "tag", "stage", "keyword", "outreach"]).default("inbound"),
    tags: z.array(z.string().max(80)).max(20).default([]),
    keyword: z.string().max(200).default(""),
    pipeline_id: z.string().max(120).default(""),
    pipeline_stage_id: z.string().max(120).default(""),
    opening_message: z.string().max(2000).default(""),
    advanced_rules: z.array(AdvancedTargetingRuleSchema).max(15).default([]),
    // Etapa 2 do plano (Pedro 2026-05-28): cap customizável de outreach pelo
    // wizard. Vazio/undefined = default 100 no specToConfig (retrocompat).
    daily_cap: z.number().int().min(1).max(5000).optional(),
  })
  .default({ mode: "inbound", tags: [], keyword: "", pipeline_id: "", pipeline_stage_id: "", opening_message: "", advanced_rules: [] });

const PostBookingSchema = z.object({
  behavior: z.enum(["stop_and_handoff", "continue_until_appointment"]).default("stop_and_handoff"),
  handoff_message: z.string().max(2000).default(""),
  allow_reschedule: z.boolean().default(true),
});

export const AgentSpecSchema = z.object({
  name: z.string().min(1).max(120),
  purpose_summary: z.string().max(600).default(""),
  // 3 canais + alias legado "whatsapp" (→ whatsapp_web). channelMap resolve.
  channels: z.array(z.enum(["whatsapp_web", "whatsapp_api", "instagram", "whatsapp"])).default(["whatsapp_web"]),
  intake: IntakeSchema,
  modules: z.array(z.string()).default([]),
  behavior: z
    .object({
      tone: ToneSchema.default(TONE_DEFAULT),
      custom_instructions: z.string().max(8000).default(""),
      conversation_examples: z.string().max(8000).default(""),
      confirmation_mode: z.enum(["always", "medium_and_high", "high_only"]).default("medium_and_high"),
    })
    .default({ tone: TONE_DEFAULT, custom_instructions: "", conversation_examples: "", confirmation_mode: "medium_and_high" }),
  qualification_fields: z.array(QualFieldSchema).max(15).optional(),
  followup: z
    .object({
      enabled: z.boolean().default(false),
      intensity: z.number().default(5),
      max_attempts: z.number().default(3),
    })
    .optional(),
  active_hours: z
    .object({
      enabled: z.boolean().default(false),
      timezone: z.string().default("America/New_York"),
      mode: z.enum(["only_during", "only_outside"]).default("only_during"),
    })
    .optional(),
  identity: z
    .object({
      name: z.string().max(80).default(""),
      mode: z.enum(["assistant", "human"]).default("assistant"),
    })
    .optional(),
  // Personality (Pedro 2026-05-28, paridade wizard ↔ detail-view): greeting,
  // farewell, persona_description. Editáveis no detail-view (CatPersonality);
  // composer agora gera baseado no propósito. Antes, wizard não capturava →
  // greeting/farewell ficavam "" e persona caía no purpose_summary.
  personality: z
    .object({
      greeting_style: z.string().max(2000).default(""),
      farewell_style: z.string().max(2000).default(""),
      persona_description: z.string().max(2000).default(""),
    })
    .optional(),
  objective: z.enum(["qualification_only", "qualification_and_booking", "booking_only"]).optional(),
  scheduling: z
    .object({
      specialist_name: z.string().max(120).default(""),
      preferred_time_slot: z.string().max(40).default("any"),
      post_booking: PostBookingSchema.optional(),
    })
    .optional(),
  // Compat: post_booking solto (versão antiga). Se vier, vira scheduling.post_booking.
  post_booking: PostBookingSchema.optional(),
  knowledge: z
    .object({
      enabled_kbs: z.array(z.enum(["national_life_group", "agency_brazillionaires"])).default([]),
      instructions: z.string().max(4000).default(""),
    })
    .optional(),
  expires_at: z.string().nullable().optional(),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** ToolDefinition `propose_agent` (modo conversa, retrocompat). */
export function proposeAgentTool(moduleKeys: string[]): ToolDefinition {
  return {
    name: "propose_agent",
    description:
      "Chame quando tiver entendido o suficiente pra montar o agente personalizado. " +
      "Emite a configuração final. Só chame quando souber propósito, intake (como os leads chegam), canais e o que coletar.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome curto e claro do agente (aparece no Spark Leads)." },
        purpose_summary: { type: "string", description: "1-2 frases em PT-BR resumindo o que o agente faz." },
        channels: {
          type: "array",
          items: { type: "string", enum: ["whatsapp_web", "whatsapp_api", "instagram"] },
          description: "Canais onde fala com os leads. whatsapp_web = WhatsApp via Stevo (o comum).",
        },
        intake: {
          type: "object",
          description: "Como os leads chegam até o agente.",
          properties: {
            mode: { type: "string", enum: ["inbound", "tag", "stage", "keyword", "outreach"] },
            tags: { type: "array", items: { type: "string" }, description: "Tags (modo tag/outreach)." },
            keyword: { type: "string", description: "Palavra-chave da campanha (modo keyword)." },
            opening_message: { type: "string", description: "1ª mensagem (modo outreach)." },
          },
        },
        modules: { type: "array", items: { type: "string", enum: moduleKeys }, description: "Ajustes/módulos extras." },
        behavior: {
          type: "object",
          properties: {
            tone: {
              type: "object",
              properties: {
                creativity: { type: "number", description: "0-100" },
                formality: { type: "number", description: "0-100" },
                naturalness: { type: "number", description: "0-100" },
                assertiveness: { type: "number", description: "0-100" },
              },
            },
            custom_instructions: { type: "string", description: "Instruções em PT-BR. NUNCA escreva 'GHL'; use 'Spark Leads'." },
            confirmation_mode: { type: "string", enum: ["always", "medium_and_high", "high_only"] },
          },
          required: ["custom_instructions"],
        },
        qualification_fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              type: { type: "string", enum: ["text", "date", "boolean", "select"] },
              required: { type: "boolean" },
            },
            required: ["label"],
          },
        },
        followup: { type: "object", properties: { enabled: { type: "boolean" }, intensity: { type: "number" }, max_attempts: { type: "number" } } },
        active_hours: { type: "object", properties: { enabled: { type: "boolean" }, timezone: { type: "string" }, mode: { type: "string", enum: ["only_during", "only_outside"] } } },
        identity: { type: "object", properties: { name: { type: "string" }, mode: { type: "string", enum: ["assistant", "human"] } } },
        objective: { type: "string", enum: ["qualification_only", "qualification_and_booking", "booking_only"] },
        scheduling: {
          type: "object",
          properties: {
            specialist_name: { type: "string" },
            preferred_time_slot: { type: "string" },
            post_booking: {
              type: "object",
              properties: {
                behavior: { type: "string", enum: ["stop_and_handoff", "continue_until_appointment"] },
                handoff_message: { type: "string" },
                allow_reschedule: { type: "boolean" },
              },
            },
          },
        },
        expires_at: { type: "string", description: "ISO (YYYY-MM-DD) se temporário. Omita se não for." },
      },
      required: ["name", "purpose_summary", "behavior"],
    },
  };
}

/** System prompt do builder conversa (retrocompat). */
export function buildBuilderSystemPrompt(moduleCatalog: { key: string; label: string }[]): string {
  const catalogList = moduleCatalog.map((m) => `- ${m.key}: ${m.label}`).join("\n");
  return `Você é o assistente de criação de agentes do Spark Hub. Monta um AGENTE PERSONALIZADO que fala com os LEADS de uma agência de seguros (PT-BR, dono não-técnico).

DESCUBRA, uma pergunta de cada vez:
- O QUE o agente faz (a campanha/oferta).
- INTAKE: como os leads chegam (mandam mensagem / por tag / por etapa do funil / palavra-chave de campanha / o agente vai atrás).
- Canais (WhatsApp/Instagram), identidade (assistente ou pessoa), objetivo (qualificar / agendar), o que coletar do lead, agendamento, follow-up, horário, se é temporário.

QUANDO TIVER O SUFICIENTE: chame propose_agent. Escreva custom_instructions ricas e específicas.

MÓDULOS:
${catalogList}

REGRAS:
- Sempre lead-facing. NUNCA escreva "GHL"/"GoHighLevel" — o CRM é "Spark Leads".
- Não invente que já criou; quem cria é o sistema após a confirmação.`;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "campo";

const CHANNEL_MAP: Record<string, CommunicationChannel> = {
  whatsapp_web: "SMS",
  whatsapp: "SMS", // alias legado
  whatsapp_api: "WhatsApp",
  instagram: "Instagram",
};

/** Mapeia o spec validado → payload de agent_configs + module_keys + expires_at. */
export function specToConfig(spec: AgentSpec, allowedModuleKeys: string[]): {
  config: Record<string, unknown>;
  moduleKeys: string[];
  expiresAt: string | null;
} {
  const enabledChannels = Array.from(new Set(spec.channels.map((c) => CHANNEL_MAP[c]).filter(Boolean)));

  const dataFields: DataField[] = (spec.qualification_fields || []).map((f, i) => ({
    key: slug(f.label) + "_" + (i + 1),
    label: f.label,
    required: f.required,
    type: f.type,
  }));

  const intake = spec.intake || { mode: "inbound" as const, tags: [], keyword: "", pipeline_id: "", pipeline_stage_id: "", opening_message: "" };
  const objective =
    spec.objective || (spec.scheduling || spec.post_booking ? "qualification_and_booking" : "qualification_only");

  // ── INTAKE → runtime ────────────────────────────────────────────
  const targetingRules: TargetingRule[] = [];
  let outreachConfig: Record<string, unknown> | null = null;
  if (intake.mode === "tag") {
    for (const t of intake.tags || []) if (t.trim()) targetingRules.push({ id: rid(), type: "tag", tag: t.trim() });
  } else if (intake.mode === "stage" && intake.pipeline_stage_id) {
    targetingRules.push({ id: rid(), type: "pipeline_stage", pipeline_id: intake.pipeline_id || undefined, pipeline_stage_id: intake.pipeline_stage_id });
  } else if (intake.mode === "outreach") {
    outreachConfig = {
      enabled: true,
      tag_filter: { tags: (intake.tags || []).filter((t) => t.trim()), match: "any" },
      rate_per_hour: 20,
      // Pedro 2026-05-28: usa o cap customizável do wizard quando vier; senão 100.
      daily_cap: intake.daily_cap || 100,
      respect_working_hours: true,
      opening_message: intake.opening_message || "",
    };
  }

  // Mescla filtros avançados do wizard (Pedro 2026-05-28). Só adiciona regras
  // completas pra não criar lixo no agent_configs.targeting_rules.
  for (const r of intake.advanced_rules || []) {
    if (r.type === "tag" && r.tag?.trim()) {
      targetingRules.push({ id: rid(), type: "tag", tag: r.tag.trim() });
    } else if (r.type === "custom_field" && r.custom_field_key?.trim() && r.custom_field_value?.trim()) {
      targetingRules.push({ id: rid(), type: "custom_field", custom_field_key: r.custom_field_key.trim(), custom_field_value: r.custom_field_value.trim() });
    } else if (r.type === "pipeline_stage" && r.pipeline_stage_id?.trim()) {
      targetingRules.push({ id: rid(), type: "pipeline_stage", pipeline_id: r.pipeline_id?.trim() || undefined, pipeline_stage_id: r.pipeline_stage_id.trim() });
    }
  }

  // Contexto de intake nas instruções (palavra-chave de campanha / prospecção).
  let customInstructions = spec.behavior.custom_instructions || "";
  if (intake.mode === "keyword" && intake.keyword.trim()) {
    customInstructions +=
      `\n\n[Entrada] Os leads chegam por uma campanha e costumam iniciar com a palavra-chave "${intake.keyword.trim()}". ` +
      `Reconheça o contexto da campanha e conduza a conversa a partir daí.`;
  }

  // ── Módulos derivados das escolhas (∪ módulos vindos do spec) ────
  const derived = new Set<string>(["channel"]);
  if (dataFields.length > 0 || objective !== "booking_only") derived.add("qualification");
  if (objective === "qualification_and_booking" || objective === "booking_only" || spec.scheduling || spec.post_booking) derived.add("scheduling");
  if (spec.followup?.enabled) derived.add("followup");
  if (spec.active_hours?.enabled) derived.add("active_hours");
  if (intake.mode === "outreach") derived.add("outreach");
  if (spec.knowledge?.enabled_kbs?.length || spec.knowledge?.instructions) derived.add("knowledge");
  for (const k of spec.modules || []) derived.add(k);
  const moduleKeys = Array.from(derived).filter((k) => allowedModuleKeys.includes(k));

  const hasFollowup = !!spec.followup?.enabled;
  const hasHours = !!spec.active_hours?.enabled;

  // Footgun: horário ligado + schedule vazio = agente mudo. Semeia seg–sex 9–18.
  const defaultSchedule = hasHours
    ? {
        monday: { enabled: true, start: "09:00", end: "18:00" },
        tuesday: { enabled: true, start: "09:00", end: "18:00" },
        wednesday: { enabled: true, start: "09:00", end: "18:00" },
        thursday: { enabled: true, start: "09:00", end: "18:00" },
        friday: { enabled: true, start: "09:00", end: "18:00" },
        saturday: { enabled: false, start: "09:00", end: "18:00" },
        sunday: { enabled: false, start: "09:00", end: "18:00" },
      }
    : {};

  const postBooking = spec.scheduling?.post_booking || spec.post_booking;

  const config: Record<string, unknown> = {
    personality: {
      name: spec.identity?.name || "",
      identity_mode: spec.identity?.mode || "assistant",
      // Pedro 2026-05-28: usa spec.personality (gerado pelo composer) se veio;
      // antes era sempre "" / purpose_summary.
      greeting_style: spec.personality?.greeting_style || "",
      farewell_style: spec.personality?.farewell_style || "",
      language: "pt-BR",
      persona_description: spec.personality?.persona_description || spec.purpose_summary || "",
    },
    tone_creativity: clamp(spec.behavior.tone.creativity),
    tone_formality: clamp(spec.behavior.tone.formality),
    tone_naturalness: clamp(spec.behavior.tone.naturalness),
    tone_aggressiveness: clamp(spec.behavior.tone.assertiveness),
    custom_instructions: customInstructions,
    conversation_examples: spec.behavior.conversation_examples || "",
    confirmation_mode: spec.behavior.confirmation_mode,
    objective,
    // Fallback "SMS" = WhatsApp Web (live); nunca "WhatsApp" (Meta, não-live).
    enabled_channels: enabledChannels.length ? enabledChannels : ["SMS"],
    data_fields: dataFields,
    targeting_rules: targetingRules,
    follow_up_config: {
      enabled: hasFollowup,
      mode: "ai_auto",
      intensity: Math.max(1, Math.min(10, Math.round(spec.followup?.intensity || 5))),
      max_attempts: Math.max(1, Math.min(20, Math.round(spec.followup?.max_attempts || 3))),
      min_delay_minutes: 10,
      max_delay_minutes: 10080,
      manual_steps: [],
    },
    working_hours: {
      enabled: hasHours,
      timezone: spec.active_hours?.timezone || "America/New_York",
      mode: spec.active_hours?.mode || "only_during",
      schedule: defaultSchedule,
    },
  };

  if (spec.scheduling?.specialist_name) config.specialist_name = spec.scheduling.specialist_name;
  if (spec.scheduling?.preferred_time_slot) config.preferred_time_slot = spec.scheduling.preferred_time_slot;
  if (postBooking) {
    config.post_booking = {
      behavior: postBooking.behavior,
      handoff_message: postBooking.handoff_message || "",
      allow_reschedule: postBooking.allow_reschedule,
    };
  }
  if (spec.knowledge?.enabled_kbs?.length) config.enabled_kbs = spec.knowledge.enabled_kbs;
  if (spec.knowledge?.instructions) config.knowledge_base_instructions = spec.knowledge.instructions;
  if (outreachConfig) config.outreach_config = outreachConfig;

  return { config, moduleKeys, expiresAt: spec.expires_at ?? null };
}
