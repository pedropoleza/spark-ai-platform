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
import { recordSignalAsync } from "@/lib/admin-signals/recorder";
import { updateRepById } from "@/lib/repositories/rep-identities.repo";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PROACTIVITY_DEFAULTS,
  type ProactivityRuleKey,
} from "@/lib/account-assistant/proactive/preferences";

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

    const now = new Date().toISOString();
    try {
      await updateRepById(ctx.rep.id, {
        timezone: tz,
        timezone_confirmed_at: now,
        updated_at: now,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        message: `Falha ao salvar timezone: ${msg}`,
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
    // Busca company_id da target location (tabela não-quente — direto)
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data: targetLocation } = await supabase
      .from("locations")
      .select("company_id, location_name")
      .eq("location_id", target.location_id)
      .maybeSingle();

    try {
      await updateRepById(ctx.rep.id, {
        active_location_id: target.location_id,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        message: `Falha ao trocar location: ${msg}`,
        retryable: true,
      };
    }
    ctx.rep.active_location_id = target.location_id;
    ctx.locationId = target.location_id;

    // Fix CRITICAL Track 4 CRIT-2 (review 2026-05-05): re-instanciar ghlClient
    // com o novo locationId (e companyId se cross-company). Antes, ghlClient
    // ficava preso no constructor com OLD locationId — próximas tools no
    // mesmo turn usavam token da location ANTIGA → 403/404 ou cross-tenant
    // data leak (body.locationId NEW + Authorization OLD = GHL pode aceitar
    // override silenciosamente). Recriar é cheap (só guarda IDs).
    const oldCompanyId = ctx.companyId;
    const newCompanyId = targetLocation?.company_id || ctx.companyId;
    if (newCompanyId !== ctx.companyId) {
      ctx.companyId = newCompanyId;
    }
    const { GHLClient } = await import("@/lib/ghl/client");
    ctx.ghlClient = new GHLClient(ctx.companyId, ctx.locationId);

    const crossCompany = oldCompanyId !== newCompanyId;
    const baseMsg = `Trocou pra "${target.location_name || target.location_id}". Próximas ações rodam nessa location.`;
    const finalMsg = crossCompany
      ? `${baseMsg} (Cross-company: ghlClient atualizado pro novo company.)`
      : baseMsg;

    return {
      status: "ok",
      data: {
        message: finalMsg,
        active_location_id: target.location_id,
        location_name: target.location_name,
        cross_company_warning: crossCompany,
      },
    };
  },
};

// =====================================================================
// Tool: report_missed_capability
// =====================================================================
const reportMissedCapability: ToolEntry = {
  def: {
    name: "report_missed_capability",
    description:
      "Registra que o rep pediu algo que você NÃO consegue fazer hoje (feature ausente, integração faltando, regra de negócio bloqueando). Pedro recebe esse log no painel admin e prioriza implementação por contagem de pedidos repetidos.\n\nCHAME ANTES de responder ao rep dizendo 'não tenho essa funcionalidade', 'não consigo fazer X', 'isso não é possível ainda'. Não chame se a tool falhou por bug ou erro técnico (essa parte é registrada automaticamente). Só pra GAPS DE CAPACIDADE — coisas que precisam ser BUILT.\n\nExemplos de quando chamar:\n- Rep pede integração com outro CRM (Pipedrive, HubSpot)\n- Rep pede analytics que não temos (relatório customizado)\n- Rep pede ação que requer feature nova (ex: agendamento recorrente complexo, multi-language detection)\n- Rep pede automação que tools atuais não cobrem\n\nNÃO chame:\n- Pra erro técnico (helper já registra automático)\n- Pra coisa que VOCÊ pode fazer mas escolheu não fazer (ex: 'vou fazer mais tarde')\n- Pra dúvida que pode ser respondida com query_carrier_knowledge",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        what_rep_wanted: {
          type: "string",
          description:
            "RESUMO em 1 linha do que o rep pediu (max ~80 chars). Use formato sintético tipo 'integração com Pipedrive', 'relatório semanal por email', 'agendamento recorrente customizado'. NÃO transcreva a frase do rep — sintetize a CAPACIDADE faltante.",
        },
        why_failed: {
          type: "string",
          description:
            "Por que não dá pra fazer hoje (1-2 frases). Ex: 'Spark Leads não expõe endpoint pra isso', 'tool create_X não existe no catálogo', 'feature precisa de OAuth com plataforma X'.",
        },
      },
      required: ["what_rep_wanted", "why_failed"],
    },
  },
  handler: async (ctx, args) => {
    const what = String(args.what_rep_wanted || "").trim();
    const why = String(args.why_failed || "").trim();
    if (!what) {
      return { status: "error", message: "what_rep_wanted obrigatório", retryable: false };
    }
    recordSignalAsync({
      type: "missed_capability",
      title: what,
      description: why,
      severity: "medium",
      source: "bot_auto",
      metadata: {
        rep_id: ctx.rep.id,
        rep_phone: ctx.rep.phone,
        location_id: ctx.locationId,
        why_failed: why,
      },
    });
    return {
      status: "ok",
      data: {
        registered: true,
        message: "Pedido registrado pro Pedro priorizar.",
      },
    };
  },
};

// ============================================================
// DAILY BRIEFING PREFERENCE (Pedro 2026-05-12)
// ============================================================
// Rep pode ligar/desligar o "Resumo matinal" diário (8h tz local).
// Persistido em rep_identities.daily_briefing_enabled (migration 00062).
// Default TRUE — todos elegíveis recebem.

const setDailyBriefing: ToolEntry = {
  def: {
    name: "set_daily_briefing",
    description:
      "Liga ou desliga o RESUMO MATINAL diário pro rep (msg proativa 8h da manhã com agendamentos do dia + resumo de ontem).\n\nUse quando rep falar:\n- 'Para de mandar resumo de manhã' / 'Não quero mais o briefing' → enabled=false\n- 'Volta a mandar resumo de manhã' / 'Quero o briefing de novo' → enabled=true\n- 'Configura briefing pra começar' → enabled=true\n\nConfirma com o rep antes de mudar.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description:
            "true = ativa o resumo matinal (default pra rep novo). false = desativa.",
        },
      },
      required: ["enabled"],
    },
  },
  handler: async (ctx, args) => {
    const enabled = args.enabled === true;
    try {
      await updateRepById(ctx.rep.id, {
        daily_briefing_enabled: enabled,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        message: `falha ao atualizar preferência: ${msg}`,
        retryable: false,
      };
    }
    return {
      status: "ok",
      data: {
        daily_briefing_enabled: enabled,
        message: enabled
          ? "Resumo matinal ativado. Vou te mandar todo dia útil às 8h da manhã com seus agendamentos + resumo do dia anterior."
          : "Resumo matinal desativado. Você pode reativar a qualquer momento.",
      },
    };
  },
};

// Liga/desliga QUALQUER proatividade pro rep (FORGE-3 2026-05-21). Persiste em
// rep_identities.proactivity_prefs (JSONB); daily_briefing delega pra coluna
// legada. É o "configurável via chat" — a UI do Spark mexe nas mesmas prefs.
const setProactivity: ToolEntry = {
  def: {
    name: "set_proactivity",
    description:
      "Liga ou desliga uma PROATIVIDADE específica pro rep (lembretes/resumos/avisos automáticos), ou ajusta a antecedência do lembrete de tarefa.\n\nUse quando o rep falar coisas como:\n- 'Ativa o lembrete de tarefa' → rule=task_reminder, enabled=true\n- 'Me lembra das tasks 30min antes' → rule=task_reminder, enabled=true, lead_min=30\n- 'Quero saber quando fecho um deal' → rule=deal_won, enabled=true\n- 'Desliga o resumo de fim do dia' → rule=end_of_day_summary, enabled=false\n- 'Me avisa de reunião marcada' → rule=pre_meeting_briefing, enabled=true\n\nRegras válidas: task_reminder (lembrete de tarefa), task_overdue (tarefa atrasada), pre_meeting_briefing (briefing antes da call), post_meeting (pós-reunião), daily_briefing (resumo matinal), end_of_day_summary (resumo fim do dia), weekly_review (reflexão semanal), pipeline_review, deal_won (deal fechado), new_lead (novo lead), no_show, opportunity_stale (opp parada), lead_cooling (lead esfriando), inbound_unanswered. Confirma a mudança com o rep depois.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        rule: {
          type: "string",
          enum: Object.keys(PROACTIVITY_DEFAULTS),
          description: "A proatividade a configurar.",
        },
        enabled: {
          type: "boolean",
          description: "true = liga essa proatividade pro rep; false = desliga.",
        },
        lead_min: {
          type: "number",
          description:
            "Só pra rule=task_reminder: quantos minutos ANTES do vencimento lembrar (default 15).",
        },
      },
      required: ["rule", "enabled"],
    },
  },
  handler: async (ctx, args) => {
    const rule = String(args.rule || "") as ProactivityRuleKey;
    if (!Object.prototype.hasOwnProperty.call(PROACTIVITY_DEFAULTS, rule)) {
      return { status: "error", message: `Proatividade desconhecida: '${rule}'.`, retryable: false };
    }
    const enabled = args.enabled === true;
    const leadMin =
      typeof args.lead_min === "number" && args.lead_min > 0 ? Math.round(args.lead_min) : undefined;
    const label = PROACTIVITY_DEFAULTS[rule].label;

    try {
      if (rule === "daily_briefing") {
        // Retrocompat: resumo matinal segue na coluna dedicada (o cron lê de lá).
        await updateRepById(ctx.rep.id, {
          daily_briefing_enabled: enabled,
          updated_at: new Date().toISOString(),
        });
      } else {
        // Merge no JSONB — lê fresco pra não sobrescrever outras prefs.
        const supabase = createAdminClient();
        const { data } = await supabase
          .from("rep_identities")
          .select("proactivity_prefs")
          .eq("id", ctx.rep.id)
          .maybeSingle();
        const cur = (data?.proactivity_prefs ?? {}) as Record<
          string,
          { enabled?: boolean; params?: Record<string, number> }
        >;
        const prevParams = cur[rule]?.params ?? {};
        const params =
          rule === "task_reminder" && leadMin ? { ...prevParams, lead_min: leadMin } : prevParams;
        cur[rule] = { enabled, ...(Object.keys(params).length ? { params } : {}) };
        await updateRepById(ctx.rep.id, {
          proactivity_prefs: cur,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `Falha ao atualizar proatividade: ${msg}`, retryable: false };
    }

    const leadNote = rule === "task_reminder" && leadMin ? ` Vou lembrar ${leadMin}min antes do vencimento.` : "";
    return {
      status: "ok",
      data: {
        rule,
        enabled,
        lead_min: leadMin ?? null,
        message: `${label} ${enabled ? "ativado" : "desativado"}.${leadNote}`,
      },
    };
  },
};

// =====================================================================
// REP ALIASES (Pedro/Gustavo 2026-05-14)
// =====================================================================
// Aliases = atalhos do rep pra termos do CRM/operação que o bot precisa
// expandir SEM perguntar a cada turn.
//
// Caso Gustavo: ele falava "puxa todos do M2" e o bot não sabia que pra
// ele "M2" = "Inscrito M2 (5k-20k)". Bot precisava perguntar ou chutar.
// Com alias salvo, prompt-builder injeta { "M2": "Inscrito M2 (5k-20k)" }
// na seção MEMÓRIA, e bot interpreta direto.
//
// Filosofia: aliases são MNEMÔNICOS pessoais (ex: nicknames de stages,
// segmentos, listas). NÃO substituem search_contacts/list_opportunities —
// rep sempre pode chamar tools com filtros explícitos. Alias só ajuda a
// expandir referência em linguagem natural.

const MAX_ALIASES_PER_REP = 50;
const MAX_ALIAS_LENGTH = 60;
const MAX_EXPANSION_LENGTH = 200;

const setRepAlias: ToolEntry = {
  def: {
    name: "set_rep_alias",
    description:
      "Salva (ou atualiza) um ALIAS pessoal do rep — atalho mnemônico que o bot deve expandir em contextos futuros. Use quando rep ENSINAR algo tipo:\n" +
      "- 'Quando eu falar M2 é o stage Inscrito M2 dos 5 ao 20k'\n" +
      "- 'M3 = Inscrito M3 dos 20k aos 50k'\n" +
      "- 'Boca Raton significa quem tem a tag mora perto de boca raton'\n" +
      "- 'Pessoal premium = quem tem opp > 50k aberta'\n\n" +
      "Após salvar, próximos turns o bot já enxerga o alias no system prompt (seção MEMÓRIA) e expande automaticamente. " +
      "Limites: max 50 aliases por rep, 60 chars no alias, 200 chars na expansão.\n\n" +
      "NÃO USE pra:\n" +
      "- Fatos sobre contato específico (use create_note)\n" +
      "- Preferência de tom/horário (será migrado pra profile.preferences/habits)\n" +
      "- Observação geral sobre o rep (use ainda profile.notes via outro fluxo)",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description: "O termo curto que o rep usa (ex: 'M2', 'premium', 'boca raton'). Case-insensitive — salva em lowercase. Max 60 chars.",
        },
        expansion: {
          type: "string",
          description: "Significado completo (ex: 'stage Inscrito M2 dos 5 ao 20k', 'tag mora perto de boca raton'). Max 200 chars. Inclua tipo (stage/tag/segmento) pra bot saber qual tool usar.",
        },
      },
      required: ["alias", "expansion"],
    },
  },
  handler: async (ctx, args) => {
    const aliasRaw = String(args.alias || "").trim();
    const expansion = String(args.expansion || "").trim();
    if (!aliasRaw || !expansion) {
      return { status: "error", message: "alias e expansion são obrigatórios", retryable: false };
    }
    if (aliasRaw.length > MAX_ALIAS_LENGTH) {
      return {
        status: "error",
        message: `alias muito longo (${aliasRaw.length} chars). Max ${MAX_ALIAS_LENGTH}. Use um atalho curto e descritivo.`,
        retryable: false,
      };
    }
    if (expansion.length > MAX_EXPANSION_LENGTH) {
      return {
        status: "error",
        message: `expansion muito longa (${expansion.length} chars). Max ${MAX_EXPANSION_LENGTH}. Resuma.`,
        retryable: false,
      };
    }
    const alias = aliasRaw.toLowerCase();

    const existingAliases = { ...(ctx.rep.profile?.aliases || {}) };
    const isUpdate = alias in existingAliases;
    if (!isUpdate && Object.keys(existingAliases).length >= MAX_ALIASES_PER_REP) {
      return {
        status: "error",
        message:
          `Já tem ${MAX_ALIASES_PER_REP} aliases salvos — limite. Remova um com forget_rep_alias antes de adicionar novo.`,
        retryable: false,
      };
    }
    existingAliases[alias] = expansion;

    const newProfile = { ...(ctx.rep.profile || {}), aliases: existingAliases };
    try {
      await updateRepById(ctx.rep.id, {
        profile: newProfile,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        message: `Falha ao salvar alias: ${msg}`,
        retryable: true,
      };
    }
    // Atualiza ctx em memória pra próximas tool calls do mesmo turn já verem
    ctx.rep.profile = newProfile;

    return {
      status: "ok",
      data: {
        alias,
        expansion,
        action: isUpdate ? "updated" : "created",
        total_aliases: Object.keys(existingAliases).length,
        message: isUpdate
          ? `Alias "${alias}" atualizado. Daqui pra frente, quando você usar "${alias}", entendo como: ${expansion}.`
          : `Alias salvo. Quando você falar "${alias}", entendo como: ${expansion}.`,
      },
    };
  },
};

const forgetRepAlias: ToolEntry = {
  def: {
    name: "forget_rep_alias",
    description:
      "Remove um alias salvo. Use quando rep falar 'esquece M2', 'apaga aquele alias', 'não usa mais X como atalho'. " +
      "Se rep não lembrar quais aliases tem, use list_rep_aliases primeiro.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Alias a remover (case-insensitive)." },
      },
      required: ["alias"],
    },
  },
  handler: async (ctx, args) => {
    const aliasRaw = String(args.alias || "").trim();
    if (!aliasRaw) {
      return { status: "error", message: "alias obrigatório", retryable: false };
    }
    const alias = aliasRaw.toLowerCase();
    const existing = { ...(ctx.rep.profile?.aliases || {}) };
    if (!(alias in existing)) {
      return {
        status: "not_found",
        message: `Nenhum alias "${alias}" salvo. Use list_rep_aliases pra ver os atuais.`,
      };
    }
    delete existing[alias];
    const newProfile = { ...(ctx.rep.profile || {}), aliases: existing };
    try {
      await updateRepById(ctx.rep.id, {
        profile: newProfile,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        message: `Falha ao remover alias: ${msg}`,
        retryable: true,
      };
    }
    ctx.rep.profile = newProfile;
    return {
      status: "ok",
      data: {
        removed: alias,
        remaining: Object.keys(existing).length,
        message: `Alias "${alias}" removido.`,
      },
    };
  },
};

const listRepAliases: ToolEntry = {
  def: {
    name: "list_rep_aliases",
    description:
      "Lista todos os aliases salvos do rep. Use quando rep perguntar 'quais atalhos você lembra de mim?', 'o que você sabe sobre meu vocabulário?', ou antes de forget_rep_alias pra confirmar qual remover.",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    const aliases = ctx.rep.profile?.aliases || {};
    const entries = Object.entries(aliases);
    if (entries.length === 0) {
      return {
        status: "ok",
        data: {
          aliases: [],
          total: 0,
          message: "Nenhum alias salvo ainda. Você pode me ensinar com 'quando eu falar X é Y'.",
        },
      };
    }
    return {
      status: "ok",
      data: {
        aliases: entries.map(([alias, expansion]) => ({ alias, expansion })),
        total: entries.length,
      },
    };
  },
};

// =====================================================================
// VERBOSITY PREFERENCE (H31.1, Pedro 2026-05-15)
// =====================================================================
// Rep pode pedir "fala mais curto" / "respostas curtas" / "menos texto"
// e bot adapta. Persistido em rep_identities.profile.preferences.verbosity.
// Bot prompt lê e adapta tamanho/detalhe das respostas.

const setVerbosityPreference: ToolEntry = {
  def: {
    name: "set_verbosity_preference",
    description:
      "Salva preferência de tom/tamanho de resposta do rep. Use quando rep falar:\n" +
      "- 'fala mais curto' / 'sem rodeios' / 'menos texto' → brief\n" +
      "- 'pode dar mais detalhe' / 'explica direito' / 'normal' → normal\n" +
      "- 'me explica tudo' / 'quero contexto' → detailed\n\n" +
      "Persistido em rep_profile.preferences.verbosity. Bot vai usar nessa preferência em TODAS as próximas respostas.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        verbosity: {
          type: "string",
          enum: ["brief", "normal", "detailed"],
          description:
            "brief = 1-2 frases max, ações primeiro. normal = padrão atual (3-5 frases). detailed = até 6-8 frases com contexto.",
        },
      },
      required: ["verbosity"],
    },
  },
  handler: async (ctx, args) => {
    const verbosity = String(args.verbosity || "normal");
    if (!["brief", "normal", "detailed"].includes(verbosity)) {
      return { status: "error", message: "verbosity inválido", retryable: false };
    }
    const currentProfile = (ctx.rep.profile || {}) as Record<string, unknown>;
    const currentPrefs = (currentProfile.preferences || {}) as Record<string, unknown>;
    const newProfile = {
      ...currentProfile,
      preferences: { ...currentPrefs, verbosity },
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await updateRepById(ctx.rep.id, { profile: newProfile as any, updated_at: new Date().toISOString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `Falha ao salvar: ${msg}`, retryable: true };
    }
    ctx.rep.profile = newProfile as typeof ctx.rep.profile;
    return {
      status: "ok",
      data: {
        verbosity,
        message:
          verbosity === "brief"
            ? "Preferência salva — vou responder mais curto a partir de agora."
            : verbosity === "detailed"
              ? "Preferência salva — vou dar mais detalhe nas respostas."
              : "Preferência salva — tom normal.",
      },
    };
  },
};

export const IDENTITY_TOOLS: ToolEntry[] = [
  confirmRepTimezone,
  listMyLocations,
  switchActiveLocation,
  reportMissedCapability,
  setDailyBriefing,
  setProactivity,
  setRepAlias,
  forgetRepAlias,
  listRepAliases,
  setVerbosityPreference,
];
