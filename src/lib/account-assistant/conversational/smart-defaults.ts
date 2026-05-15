/**
 * Smart Defaults Resolver (H29.4, Pedro 2026-05-15).
 *
 * Antes de cada tool call, processor preenche slots automaticamente
 * que rep NÃO precisa fornecer. Reduz "qual fuso?", "qual location?",
 * "atribuir a quem?", etc — bot infere do contexto do rep.
 *
 * 6 categorias de defaults:
 *   1. timezone — rep.timezone (não pergunta de novo)
 *   2. location — rep.active_location_id (já resolvido no onboarding)
 *   3. assigned_to — rep.ghl_user_id da location ativa (não pergunta "self")
 *   4. delivery_channel — env ASSISTANT_OUTBOUND_CHANNEL (default whatsapp)
 *   5. variation_mode — "light" default
 *   6. interval_seconds — 90s ± 30s jitter (anti-ban)
 *
 * Tools podem opcionalmente CHAMAR applySmartDefaults antes de validar
 * args, OU consumir defaults via helpers.
 */

import type { ToolContext } from "../tools/types";
import { getRepGhlUserId } from "../tools/types";

/**
 * Defaults consolidados pro rep+location atual.
 * Lido uma vez por turn — passado pras tools.
 */
export interface SmartDefaults {
  timezone: string;                    // IANA, sempre presente
  active_location_id: string;
  rep_ghl_user_id: string | undefined;
  delivery_channel: "whatsapp_web_sms" | "whatsapp_api" | "Email" | "SMS";
  bulk_interval_seconds: number;
  bulk_jitter_seconds: number;
  bulk_variation_mode: "none" | "light" | "medium";
  /** Quando true, bot pode omitir confirmações triviais com inferência alta */
  rep_prefers_brief: boolean;
  /** Cap diário bulk msgs */
  bulk_daily_cap: number;
}

/**
 * Computa defaults pra um ctx. Sem chamadas externas — só lê ctx + env.
 */
export function computeSmartDefaults(ctx: ToolContext): SmartDefaults {
  const rep = ctx.rep;
  const repTimezone =
    (rep as { timezone?: string | null }).timezone ||
    "America/New_York";
  const verbosityPref = (rep.profile?.preferences as { verbosity?: string } | undefined)?.verbosity;

  // Canal padrão — env override (mas typed) — defaults SMS via Stevo
  const envChannel = (process.env.ASSISTANT_OUTBOUND_CHANNEL || "SMS") as
    | "whatsapp_web_sms"
    | "whatsapp_api"
    | "Email"
    | "SMS";

  return {
    timezone: repTimezone,
    active_location_id: ctx.locationId,
    rep_ghl_user_id: getRepGhlUserId(ctx),
    delivery_channel: envChannel,
    bulk_interval_seconds: 90,
    bulk_jitter_seconds: 30,
    bulk_variation_mode: "light",
    rep_prefers_brief: verbosityPref === "brief",
    bulk_daily_cap: 100,
  };
}

/**
 * Renderiza defaults como bloco curto pro system prompt.
 * Bot lê e SABE quais valores assumir sem perguntar.
 */
export function renderSmartDefaultsForPrompt(defaults: SmartDefaults): string {
  return [
    "# SMART DEFAULTS — valores já resolvidos (NÃO pergunte)",
    `• Timezone do rep: *${defaults.timezone}* (use pra todo schedule_reminder, create_appointment, etc)`,
    `• Active location: já resolvida (use ctx; não pergunte)`,
    `• Atribuição default (tasks, opps, etc): rep ATUAL — só pergunte se rep falar "pro João" ou nome diferente`,
    `• Canal envio msg: *${defaults.delivery_channel}* (default — só override se rep falar "email", "instagram", etc)`,
    `• Bulk intervalo: ${defaults.bulk_interval_seconds}s ± ${defaults.bulk_jitter_seconds}s (anti-ban — NÃO pergunte; relaxe só se rep falar "rápido"/"sem espaço")`,
    `• Bulk variation: ${defaults.bulk_variation_mode}`,
    `• Bulk daily cap: ${defaults.bulk_daily_cap} msgs/24h por location`,
    `• Verbosity pref do rep: ${defaults.rep_prefers_brief ? "brief (1-2 frases)" : "normal"}`,
    "",
    "REGRA: estes defaults SÃO o que assumir. Pergunte SÓ se rep menciona algo diferente OU contexto é 100% ambíguo.",
  ].join("\n");
}
