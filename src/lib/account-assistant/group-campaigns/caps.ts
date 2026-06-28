/**
 * Caps anti-ban ENFORÇADOS de campanha de grupo (H46, decisão Pedro #1).
 *
 * O número que entrega no grupo é o MESMO do DM do SparkBot — um ban derruba o
 * copiloto. Por isso os limites diários NÃO são decorativos: são checados por query
 * real (recipients de grupo ativos nas últimas 24h) ANTES de agendar. Janela rolante
 * de 24h (não dia-calendário) — sem matemática de fuso, e mais conservador.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  GROUP_MAX_GROUPS_PER_DAY,
  GROUP_MAX_MSGS_PER_GROUP_PER_DAY,
  GROUP_MAX_MSGS_PER_DAY_TOTAL,
} from "./config";

export interface GroupCaps {
  maxGroupsPerDay: number;
  maxMsgsPerGroupPerDay: number;
  maxMsgsPerDayTotal: number;
}

export const DEFAULT_GROUP_CAPS: GroupCaps = {
  maxGroupsPerDay: GROUP_MAX_GROUPS_PER_DAY,
  maxMsgsPerGroupPerDay: GROUP_MAX_MSGS_PER_GROUP_PER_DAY,
  maxMsgsPerDayTotal: GROUP_MAX_MSGS_PER_DAY_TOTAL,
};

export type CapVerdict =
  | { ok: true }
  | { ok: false; reason: "groups_per_day" | "msgs_per_day" | "msgs_per_group"; message: string };

/**
 * Avalia se agendar `planned` (contact_ids dos grupos-alvo, 1 entrada por msg) estoura
 * os caps, dado o que JÁ está ativo nas últimas 24h (`existingByGroup`: contact_id→nº).
 * PURO/testável.
 */
export function evaluateGroupCaps(
  existingByGroup: Map<string, number>,
  planned: string[],
  caps: GroupCaps = DEFAULT_GROUP_CAPS,
): CapVerdict {
  const plannedByGroup = new Map<string, number>();
  for (const id of planned) plannedByGroup.set(id, (plannedByGroup.get(id) || 0) + 1);

  const existingTotal = [...existingByGroup.values()].reduce((a, b) => a + b, 0);
  const newGroups = [...plannedByGroup.keys()].filter((id) => !existingByGroup.has(id)).length;
  const totalGroups = existingByGroup.size + newGroups;
  const totalMsgs = existingTotal + planned.length;

  if (totalGroups > caps.maxGroupsPerDay) {
    return {
      ok: false,
      reason: "groups_per_day",
      message:
        `Já tenho ${caps.maxGroupsPerDay} grupo(s) no limite seguro de hoje (pra proteger seu número de bloqueio). ` +
        `Posso agendar pra amanhã, ou troca por outros grupos dentro do limite?`,
    };
  }
  if (totalMsgs > caps.maxMsgsPerDayTotal) {
    return {
      ok: false,
      reason: "msgs_per_day",
      message:
        `Isso passaria do limite seguro de ${caps.maxMsgsPerDayTotal} envios de grupo por dia (anti-bloqueio). ` +
        `Agendo o excedente pra amanhã?`,
    };
  }
  for (const [id, n] of plannedByGroup) {
    if ((existingByGroup.get(id) || 0) + n > caps.maxMsgsPerGroupPerDay) {
      return {
        ok: false,
        reason: "msgs_per_group",
        message:
          `Esse grupo já bate o limite de ${caps.maxMsgsPerGroupPerDay} post(s) por dia (pra não parecer spam). ` +
          `Deixa pro próximo dia?`,
      };
    }
  }
  return { ok: true };
}

/**
 * Checa os caps contra o DB (recipients de grupo ativos da location nas últimas 24h).
 * Fail-OPEN: erro de query NÃO bloqueia o agendamento (o pacing/spam-advisor seguem).
 */
export async function checkGroupDailyCaps(
  supabase: ReturnType<typeof createAdminClient>,
  locationId: string,
  plannedContactIds: string[],
  caps: GroupCaps = DEFAULT_GROUP_CAPS,
): Promise<CapVerdict> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // 2 queries (em vez de filtro em embedded resource, que falha silencioso em alguns
    // setups e zeraria o enforcement). Jobs de grupo da location criados nas últimas 48h
    // cobrem os recipients agendados pras últimas 24h (recorrência cria job filho novo).
    const sinceJobs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: jobs, error: jobsErr } = await supabase
      .from("bulk_message_jobs")
      .select("id")
      .eq("location_id", locationId)
      .eq("target_type", "groups")
      .gte("created_at", sinceJobs);
    if (jobsErr) {
      console.warn("[group-caps] jobs query falhou (fail-open):", jobsErr.message);
      return { ok: true };
    }
    const jobIds = (jobs || []).map((j) => j.id as string);
    if (jobIds.length === 0) return evaluateGroupCaps(new Map(), plannedContactIds, caps);

    const { data, error } = await supabase
      .from("bulk_message_recipients")
      .select("contact_id")
      .in("job_id", jobIds)
      .eq("is_group", true)
      .in("status", ["sent", "sending", "pending"])
      .gte("scheduled_at", since);
    if (error) {
      console.warn("[group-caps] recipients query falhou (fail-open):", error.message);
      return { ok: true };
    }
    const existingByGroup = new Map<string, number>();
    for (const r of (data || []) as Array<{ contact_id: string }>) {
      existingByGroup.set(r.contact_id, (existingByGroup.get(r.contact_id) || 0) + 1);
    }
    return evaluateGroupCaps(existingByGroup, plannedContactIds, caps);
  } catch (err) {
    console.warn("[group-caps] erro (fail-open):", err instanceof Error ? err.message : err);
    return { ok: true };
  }
}
