/**
 * Preferências de proatividade POR REP (FORGE-3 2026-05-21).
 *
 * Dois eixos de config (decisão D1 com o Pedro):
 *  - GLOBAL (admin, UI do Spark): assistant_proactive_rules.enabled — quais regras
 *    existem/estão disponíveis pro agente. (Não é resolvido aqui.)
 *  - POR REP (chat + UI): rep_identities.proactivity_prefs — cada rep liga/desliga
 *    pra si as regras que estão disponíveis. É o que este módulo resolve.
 *
 * Regra dispara pro rep SSE (global enabled — checado no cron/router) E
 * (rep opt-in — `resolveProactivityPref`). Ausência de pref = default da matriz.
 *
 * `daily_briefing` continua na coluna legada `daily_briefing_enabled` (o cron lê
 * de lá); o `set_proactivity` delega pra ela. As demais regras vivem no JSONB.
 */

import type { RepIdentity } from "@/types/account-assistant";

/** Chaves de regra configuráveis por rep. Mapeiam pras system-rules + eventos. */
export type ProactivityRuleKey =
  | "task_reminder" // lembrete de tarefa do GHL (due − lead_min)
  | "task_overdue" // tarefa atrasada
  | "pre_meeting_briefing" // briefing 15min antes da call (contextual)
  | "post_meeting" // pós-reunião
  | "daily_briefing" // resumo matinal (coluna legada)
  | "end_of_day_summary" // resumo fim do dia
  | "weekly_review" // reflexão semanal
  | "pipeline_review" // pipeline review
  | "deal_won" // deal fechado
  | "new_lead" // novo lead atribuído
  | "no_show" // no-show
  | "opportunity_stale" // opp parada (polling — build depois)
  | "lead_cooling" // lead esfriando (polling — build depois)
  | "inbound_unanswered"; // inbound não respondida (polling — build depois)

interface RuleDefault {
  /** Liga por padrão? (Pedro: úteis ON, nicho OFF.) */
  defaultOn: boolean;
  /** Rótulo curto pra UI/chat. */
  label: string;
  /** Params default da regra (ex: lead_min do lembrete de task). */
  params?: Record<string, number>;
}

/** Matriz de defaults (assinada com o Pedro 2026-05-21). */
export const PROACTIVITY_DEFAULTS: Record<ProactivityRuleKey, RuleDefault> = {
  task_reminder: { defaultOn: true, label: "Lembrete de tarefa", params: { lead_min: 15 } },
  daily_briefing: { defaultOn: true, label: "Resumo matinal" },
  post_meeting: { defaultOn: true, label: "Pós-reunião" },
  pre_meeting_briefing: { defaultOn: true, label: "Briefing pré-reunião" }, // contextual: pula se vazio
  task_overdue: { defaultOn: false, label: "Tarefa atrasada" },
  deal_won: { defaultOn: false, label: "Deal fechado" },
  new_lead: { defaultOn: false, label: "Novo lead atribuído" },
  no_show: { defaultOn: false, label: "No-show" },
  end_of_day_summary: { defaultOn: false, label: "Resumo fim do dia" },
  weekly_review: { defaultOn: false, label: "Reflexão semanal" },
  pipeline_review: { defaultOn: false, label: "Pipeline review" },
  opportunity_stale: { defaultOn: false, label: "Opportunity parada" },
  lead_cooling: { defaultOn: false, label: "Lead esfriando" },
  inbound_unanswered: { defaultOn: false, label: "Inbound não respondida" },
};

export interface ResolvedPref {
  enabled: boolean;
  /** Params efetivos (default da matriz + override do rep). */
  params: Record<string, number>;
}

/**
 * Resolve a preferência efetiva do rep pra uma regra. Ausência → default.
 * `daily_briefing` honra a coluna legada `daily_briefing_enabled` (retrocompat).
 */
export function resolveProactivityPref(
  rep: Pick<RepIdentity, "proactivity_prefs" | "daily_briefing_enabled">,
  key: ProactivityRuleKey,
): ResolvedPref {
  const def = PROACTIVITY_DEFAULTS[key];
  const baseParams = def.params ?? {};

  // Retrocompat: resumo matinal segue na coluna dedicada.
  if (key === "daily_briefing") {
    return {
      enabled: rep.daily_briefing_enabled !== false, // default ON
      params: { ...baseParams },
    };
  }

  const pref = rep.proactivity_prefs?.[key];
  const enabled = typeof pref?.enabled === "boolean" ? pref.enabled : def.defaultOn;
  return {
    enabled,
    params: { ...baseParams, ...(pref?.params ?? {}) },
  };
}

/** Lead time (min) do lembrete de tarefa pra esse rep. Default 15, configurável. */
export function taskReminderLeadMin(
  rep: Pick<RepIdentity, "proactivity_prefs" | "daily_briefing_enabled">,
): number {
  const { params } = resolveProactivityPref(rep, "task_reminder");
  const lead = params.lead_min;
  return Number.isFinite(lead) && lead > 0 ? lead : 15;
}
