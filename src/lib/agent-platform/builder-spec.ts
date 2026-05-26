/**
 * Builder de agente custom com IA (Plataforma Modular — Fase F).
 *
 * A IA (Claude) conversa com o usuário em PT-BR e, quando entende o pedido,
 * chama a tool `propose_agent` emitindo um SPEC estruturado. Aqui ficam:
 *  - AgentSpecSchema (zod) — valida o que o modelo emitiu (nunca confiar cru).
 *  - proposeAgentTool() — a ToolDefinition (JSON schema) ofertada ao modelo.
 *  - buildBuilderSystemPrompt() — system prompt do builder.
 *  - specToConfig() — mapeia o spec → agent_configs + module_keys (1:1 com o
 *    runtime real; o agente nasce pausado pra revisão).
 */
import { z } from "zod";
import type { ToolDefinition } from "@/types/account-assistant";
import type { CommunicationChannel, DataField } from "@/types/agent";

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));

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

export const AgentSpecSchema = z.object({
  name: z.string().min(1).max(120),
  purpose_summary: z.string().max(600).default(""),
  channels: z.array(z.enum(["whatsapp", "instagram"])).default(["whatsapp"]),
  modules: z.array(z.string()).default([]),
  behavior: z
    .object({
      tone: ToneSchema.default(TONE_DEFAULT),
      custom_instructions: z.string().max(8000).default(""),
      confirmation_mode: z.enum(["always", "medium_and_high", "high_only"]).default("medium_and_high"),
    })
    .default({ tone: TONE_DEFAULT, custom_instructions: "", confirmation_mode: "medium_and_high" }),
  qualification_fields: z.array(QualFieldSchema).max(12).optional(),
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
  objective: z.enum(["qualification_only", "qualification_and_booking", "booking_only"]).optional(),
  post_booking: z
    .object({
      behavior: z.enum(["stop_and_handoff", "continue_until_appointment"]).default("stop_and_handoff"),
      handoff_message: z.string().max(2000).default(""),
      allow_reschedule: z.boolean().default(true),
    })
    .optional(),
  expires_at: z.string().nullable().optional(),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** ToolDefinition `propose_agent` ofertada ao modelo. `moduleKeys` = catálogo válido. */
export function proposeAgentTool(moduleKeys: string[]): ToolDefinition {
  return {
    name: "propose_agent",
    description:
      "Chame quando tiver entendido o suficiente pra montar o agente personalizado. " +
      "Emite a configuração final. Só chame quando já souber o propósito, os canais e o que coletar.",
    // Sem side-effect (só emite o spec) → safe, não precisa de confirmação.
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome curto e claro do agente (aparece no Spark Leads)." },
        purpose_summary: { type: "string", description: "1-2 frases em PT-BR resumindo o que o agente faz." },
        channels: {
          type: "array",
          items: { type: "string", enum: ["whatsapp", "instagram"] },
          description: "Canais onde fala com os leads.",
        },
        modules: {
          type: "array",
          items: { type: "string", enum: moduleKeys },
          description: "Ajustes/módulos que o agente carrega (escolha os que fazem sentido pro propósito).",
        },
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
            custom_instructions: { type: "string", description: "Instruções em PT-BR sobre a agência e como agir. NUNCA escreva 'GHL'; use 'Spark Leads'." },
            confirmation_mode: { type: "string", enum: ["always", "medium_and_high", "high_only"] },
          },
          required: ["custom_instructions"],
        },
        qualification_fields: {
          type: "array",
          description: "Perguntas que o agente faz pra qualificar o lead.",
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
        followup: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            intensity: { type: "number", description: "1-10" },
            max_attempts: { type: "number" },
          },
        },
        active_hours: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            timezone: { type: "string" },
            mode: { type: "string", enum: ["only_during", "only_outside"] },
          },
        },
        identity: {
          type: "object",
          description: "Como o agente se apresenta ao lead.",
          properties: {
            name: { type: "string", description: "Nome do agente (ex: Bia, Léo)." },
            mode: { type: "string", enum: ["assistant", "human"], description: "Se apresenta como assistente virtual ou como pessoa." },
          },
        },
        objective: {
          type: "string",
          enum: ["qualification_only", "qualification_and_booking", "booking_only"],
          description: "O que o agente tenta fazer: só qualificar, qualificar + agendar, ou só agendar.",
        },
        post_booking: {
          type: "object",
          description: "O que fazer depois de marcar a reunião.",
          properties: {
            behavior: { type: "string", enum: ["stop_and_handoff", "continue_until_appointment"] },
            handoff_message: { type: "string", description: "Mensagem ao passar pra humano." },
            allow_reschedule: { type: "boolean" },
          },
        },
        expires_at: { type: "string", description: "Data ISO (YYYY-MM-DD) se o agente é temporário (evento/feirão). Omita se não for." },
      },
      required: ["name", "purpose_summary", "modules", "behavior"],
    },
  };
}

/** System prompt do builder. `moduleCatalog` = [{key,label}] pra guiar a escolha. */
export function buildBuilderSystemPrompt(moduleCatalog: { key: string; label: string }[]): string {
  const catalogList = moduleCatalog.map((m) => `- ${m.key}: ${m.label}`).join("\n");
  return `Você é o assistente de criação de agentes do Spark Hub. Sua missão: conversar com o dono de uma agência de seguros (PT-BR, não-técnico, 30-50 anos) e montar um AGENTE PERSONALIZADO que fale com os LEADS dele.

COMO CONDUZIR:
- Fale como gente, em português claro e acolhedor. Uma pergunta de cada vez.
- Comece entendendo O QUE o agente deve fazer. Depois descubra: com quem fala, por quais canais (WhatsApp/Instagram), se precisa marcar reunião, o que coletar do lead, se tem horário, se é temporário (evento/feirão com data pra expirar).
- Explique as opções quando a pessoa não souber. Seja breve.
- NÃO peça dados técnicos. Você cuida da parte técnica.

QUANDO TIVER O SUFICIENTE:
- Chame a tool propose_agent com a configuração. Escolha módulos coerentes com o propósito.
- Dê um NOME ao agente (identity.name) e diga se ele se apresenta como assistente ou como pessoa.
- Defina o OBJETIVO (só qualificar / qualificar + agendar / só agendar) e, se agenda, o que faz depois (post_booking).
- Escreva instruções (custom_instructions) ricas e específicas pro agente, baseadas no que a pessoa disse.
- Defina o tom (0-100) que combina com o propósito.

MÓDULOS DISPONÍVEIS (use as keys):
${catalogList}

REGRAS:
- O agente é sempre lead-facing (fala com clientes/leads, não com o operador).
- NUNCA escreva "GHL" nem "GoHighLevel" — o CRM se chama "Spark Leads".
- Só fale sobre montar este agente. Se pedirem outra coisa, redirecione gentilmente.
- Não invente que já criou — quem cria é o sistema depois que a pessoa confirma.`;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "campo";

/** Mapeia o spec validado → payload de agent_configs + module_keys + expires_at. */
export function specToConfig(spec: AgentSpec, allowedModuleKeys: string[]): {
  config: Record<string, unknown>;
  moduleKeys: string[];
  expiresAt: string | null;
} {
  // whatsapp → "SMS" (WhatsApp Web via Stevo, o canal live). WhatsApp API (Meta)
  // o usuário liga depois na config se tiver. instagram → "Instagram".
  const channelMap: Record<string, CommunicationChannel> = { whatsapp: "SMS", instagram: "Instagram" };
  const enabledChannels = Array.from(new Set(spec.channels.map((c) => channelMap[c]).filter(Boolean)));

  const dataFields: DataField[] = (spec.qualification_fields || []).map((f, i) => ({
    key: slug(f.label) + "_" + (i + 1),
    label: f.label,
    required: f.required,
    type: f.type,
  }));

  // whitelist + dedup das module keys (antes, pra derivar os flags de on/off).
  const moduleKeys = Array.from(new Set(spec.modules.filter((k) => allowedModuleKeys.includes(k))));
  const hasFollowup = moduleKeys.includes("followup") || !!spec.followup?.enabled;
  const hasHours = moduleKeys.includes("active_hours") || !!spec.active_hours?.enabled;

  const config: Record<string, unknown> = {
    personality: {
      name: spec.identity?.name || "",
      identity_mode: spec.identity?.mode || "assistant",
      greeting_style: "",
      farewell_style: "",
      language: "pt-BR",
      persona_description: spec.purpose_summary || "",
    },
    tone_creativity: clamp(spec.behavior.tone.creativity),
    tone_formality: clamp(spec.behavior.tone.formality),
    tone_naturalness: clamp(spec.behavior.tone.naturalness),
    tone_aggressiveness: clamp(spec.behavior.tone.assertiveness),
    custom_instructions: spec.behavior.custom_instructions,
    confirmation_mode: spec.behavior.confirmation_mode,
    objective: spec.objective || (moduleKeys.includes("scheduling") ? "qualification_and_booking" : "qualification_only"),
    enabled_channels: enabledChannels.length ? enabledChannels : ["WhatsApp"],
    data_fields: dataFields,
    // Flags derivados do módulo → config e composição ficam coerentes.
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
      schedule: {},
    },
  };

  if (spec.post_booking) {
    config.post_booking = {
      behavior: spec.post_booking.behavior,
      handoff_message: spec.post_booking.handoff_message || "",
      allow_reschedule: spec.post_booking.allow_reschedule,
    };
  }

  return { config, moduleKeys, expiresAt: spec.expires_at ?? null };
}
