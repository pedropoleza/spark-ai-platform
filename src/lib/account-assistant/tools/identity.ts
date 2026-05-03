/**
 * Tools de identidade/perfil do rep (não-GHL). Atualmente só
 * `confirm_rep_timezone` — chamada antes da primeira tool tz-sensitive.
 *
 * Filosofia (decidida com Pedro 2026-05-03): GHL user.timezone vira sugestão,
 * NÃO confirmação automática. Bot pergunta uma vez ao rep, salva via essa
 * tool, daí pra frente todas as tools de horário rodam sem perguntar de novo.
 * Reset: rep diz "muda meu fuso pra X" → bot rechama essa tool com novo IANA.
 */

import type { ToolEntry } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Valida IANA timezone usando Intl.DateTimeFormat. Inválido (typo, vazio,
 * lixo) lança RangeError → retornamos false.
 */
function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const confirmRepTimezone: ToolEntry = {
  def: {
    name: "confirm_rep_timezone",
    description:
      "Salva o timezone do rep no perfil + marca como confirmado pelo rep. " +
      "CHAME quando o rep confirmar verbalmente o fuso ('sim, é esse', 'tô na Florida') " +
      "OU informar outro ('to em SP agora', 'fuso de Brasília'). " +
      "Após chamar, próximas tools com horário (schedule_reminder, create_appointment, " +
      "etc.) rodam direto — gate de timezone fica satisfeito. " +
      "Reset: chame de novo se o rep informar mudança de fuso (viagem etc).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description:
            "Timezone IANA (ex: 'America/New_York', 'America/Sao_Paulo', 'Europe/Lisbon'). " +
            "Se rep disser 'Florida', use 'America/New_York'. Se 'São Paulo'/'horário de Brasília', " +
            "use 'America/Sao_Paulo'. NUNCA use abreviações (EDT, PST, BRT) — só IANA.",
        },
      },
      required: ["timezone"],
    },
  },
  handler: async (ctx, args) => {
    const tz = String(args.timezone || "").trim();
    if (!isValidIanaTimezone(tz)) {
      return {
        status: "error",
        message:
          `Timezone inválido: "${tz}". Use IANA tipo 'America/New_York' ou 'America/Sao_Paulo'. ` +
          `Não use abreviação (EDT, BRT). Pergunte ao rep o local (cidade/estado) e mapeie.`,
        retryable: false,
      };
    }

    const supabase = createAdminClient();
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("rep_identities")
      .update({
        timezone: tz,
        timezone_confirmed_at: now,
        updated_at: now,
      })
      .eq("id", ctx.rep.id);

    if (error) {
      return {
        status: "error",
        message: `Falha ao salvar timezone: ${error.message}`,
        retryable: true,
      };
    }

    // Atualiza ctx.rep em memória pra próximas tool calls do mesmo turn
    // já enxergarem o timezone confirmado (evita re-trigger do gate na
    // chamada subsequente do schedule_reminder no mesmo loop multi-turn).
    ctx.rep.timezone = tz;
    ctx.rep.timezone_confirmed_at = now;

    return {
      status: "ok",
      data: {
        timezone: tz,
        confirmed_at: now,
        message: `Timezone do rep salvo como ${tz}. Próximas tools de horário rodam direto.`,
      },
    };
  },
};

export const IDENTITY_TOOLS: ToolEntry[] = [confirmRepTimezone];
