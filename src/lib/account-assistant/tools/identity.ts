/**
 * Tools de identidade/perfil do rep (não-GHL):
 *   - `confirm_rep_timezone` — chamada antes da primeira tool tz-sensitive.
 *   - `list_my_locations` — pra rep ver quais sub-accounts ele tem acesso.
 *   - `switch_active_location` — troca a sub-account ativa (multi-tenant reps).
 *
 * Filosofia timezone (Pedro 2026-05-03): GHL user.timezone é sugestão, NÃO
 * confirmação automática. Bot pergunta uma vez, salva, daí em diante usa.
 *
 * Filosofia location switch (Pedro 2026-05-04): 95% dos reps tem 1 location
 * (auto-resolve no onboarding). Pra os que tem múltiplas (gerentes, agency
 * owners), tool `switch_active_location` permite trocar via comando — antes
 * disso, switch só rolava no primeiro turno do onboarding e ficava preso.
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

// =====================================================================
// Tool: list_my_locations
// =====================================================================
const listMyLocations: ToolEntry = {
  def: {
    name: "list_my_locations",
    description:
      "Lista as sub-accounts (locations) do Spark Leads que o rep tem acesso, marcando qual está ativa AGORA. Use quando rep perguntar 'em quais contas eu tenho acesso?', 'quais locations eu tenho?', ou ANTES de propor switch_active_location pra mostrar opções.",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    const list = ctx.rep.ghl_users.map((u) => ({
      location_id: u.location_id,
      location_name: u.location_name || u.location_id,
      role: u.role || null,
      is_active: u.location_id === ctx.locationId,
    }));
    return {
      status: "ok",
      data: {
        active_location_id: ctx.locationId,
        total_locations: list.length,
        locations: list,
      },
    };
  },
};

// =====================================================================
// Tool: switch_active_location
// =====================================================================
const switchActiveLocation: ToolEntry = {
  def: {
    name: "switch_active_location",
    description:
      "Troca a sub-account (location) ativa do rep. Use quando rep falar 'troca pra X', 'muda pra location Y', 'agora to operando no Z'.\n\nRegras de segurança:\n- SE rep só tem 1 location: tool rejeita (não tem o que trocar).\n- SE match ambíguo (query bate em várias): tool retorna lista pra você perguntar qual.\n- SE nenhum match: tool retorna lista de opções disponíveis.\n- SE match único: troca + confirma o nome novo.\n\nSEMPRE confirme com o rep ANTES de trocar ('Vou trocar pra X, confirma?'), porque tools subsequentes vão rodar contra a nova location.",
    // medium pra exigir confirmação no modo padrão (medium_and_high) — switch
    // afeta TUDO daqui pra frente, vale o gate humano.
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        location_query: {
          type: "string",
          description:
            "Nome (ou parte do nome) ou ID da location alvo. Ex: 'DTLBiz', 'Spark Leads', 'CovT3LBbh5Ic7OEHJkg9'. Match é case-insensitive e por substring no location_name, OU exato no location_id.",
        },
      },
      required: ["location_query"],
    },
  },
  handler: async (ctx, args) => {
    const query = String(args.location_query || "").trim();
    if (!query) {
      return { status: "error", message: "location_query obrigatória", retryable: false };
    }
    const userLocations = ctx.rep.ghl_users;

    // Safety: se só tem 1 location, não tem o que trocar
    if (userLocations.length <= 1) {
      return {
        status: "error",
        message:
          `Você só tem acesso a 1 location (${userLocations[0]?.location_name || userLocations[0]?.location_id || "atual"}), não tem o que trocar.`,
        retryable: false,
      };
    }

    // Match: exato no ID (sempre vence) OR substring case-insensitive no nome
    const queryLower = query.toLowerCase();
    const exactById = userLocations.find((u) => u.location_id === query);
    const matches = exactById
      ? [exactById]
      : userLocations.filter(
          (u) =>
            u.location_name &&
            u.location_name.toLowerCase().includes(queryLower),
        );

    if (matches.length === 0) {
      const list = userLocations
        .map(
          (u, i) =>
            `${i + 1}. ${u.location_name || u.location_id}${u.location_id === ctx.locationId ? " (atual)" : ""}`,
        )
        .join("\n");
      return {
        status: "error",
        message: `Nenhuma location bate com "${query}". Suas locations:\n${list}\n\nMe diz o nome certo ou o número.`,
        retryable: true,
      };
    }
    if (matches.length > 1) {
      const list = matches
        .map((u, i) => `${i + 1}. ${u.location_name || u.location_id}`)
        .join("\n");
      return {
        status: "error",
        message: `"${query}" bateu em mais de uma location:\n${list}\n\nQual delas? Me manda o nome completo.`,
        retryable: true,
      };
    }

    const target = matches[0];

    // Já tá nessa location? No-op com confirmação
    if (target.location_id === ctx.locationId) {
      return {
        status: "ok",
        data: {
          message: `Você já tá operando em "${target.location_name || target.location_id}" — nada pra trocar.`,
          active_location_id: target.location_id,
          location_name: target.location_name,
          no_change: true,
        },
      };
    }

    // Persiste no DB + atualiza ctx.rep + ctx.locationId em memória pro
    // mesmo turn (pra próximas tool calls do multi-turn já enxergarem).
    //
    // IMPORTANTE: ctx.companyId vem do escopo do processor, fixado no início
    // do turn. Se a target_location for de OUTRO company (rar — agency
    // owner com multi-company), as próximas tools (que usam ctx.ghlClient)
    // ainda apontam pro company anterior. Pra esse caso edge, retornamos
    // aviso no message — rep deve mandar próxima request num turn novo.
    const supabase = createAdminClient();
    const { data: targetLocation } = await supabase
      .from("locations")
      .select("company_id, location_name")
      .eq("location_id", target.location_id)
      .maybeSingle();

    const { error } = await supabase
      .from("rep_identities")
      .update({
        active_location_id: target.location_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ctx.rep.id);
    if (error) {
      return {
        status: "error",
        message: `Falha ao trocar location: ${error.message}`,
        retryable: true,
      };
    }
    ctx.rep.active_location_id = target.location_id;
    ctx.locationId = target.location_id;

    const crossCompany =
      targetLocation && targetLocation.company_id !== ctx.companyId;
    const baseMsg = `Trocou pra "${target.location_name || target.location_id}". Próximas ações rodam nessa location.`;
    const finalMsg = crossCompany
      ? `${baseMsg} (Aviso: location é de outra agency — pode precisar repetir o pedido em uma nova mensagem.)`
      : baseMsg;

    return {
      status: "ok",
      data: {
        message: finalMsg,
        active_location_id: target.location_id,
        location_name: target.location_name,
        cross_company_warning: crossCompany ?? false,
      },
    };
  },
};

export const IDENTITY_TOOLS: ToolEntry[] = [
  confirmRepTimezone,
  listMyLocations,
  switchActiveLocation,
];
