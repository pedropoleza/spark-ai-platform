/**
 * Quiet hours check — compartilhado entre bulk-runner e recurring-runner
 * (Pedro 2026-05-28 F14).
 *
 * Lê `agent_configs.quiet_hours` e retorna true se o momento (now ou ts
 * passado) está dentro da janela de silêncio. Sem agent ou config = false
 * (não respeita).
 *
 * Antes esta função existia inline em bulk-message-runner.ts. Recurring runner
 * não checava e podia disparar campanha às 23h se cron fosse "0 23 * * *" —
 * conflito com quiet_hours 22-7 do agente.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface QuietHoursConfig {
  enabled?: boolean;
  timezone?: string;
  start?: string;
  end?: string;
  days?: number[];
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Checa se `ts` (default now) cai dentro da janela quiet_hours do agente.
 * Retorna false defensivo se: agent_id null, sem config, enabled=false,
 * erro de Intl. Janela cross-midnight (22h-7h) é suportada.
 */
export async function isInQuietHours(
  agentId: string | null,
  ts: Date = new Date(),
): Promise<boolean> {
  if (!agentId) return false;
  const supabase = createAdminClient();
  const { data: config } = await supabase
    .from("agent_configs")
    .select("quiet_hours")
    .eq("agent_id", agentId)
    .maybeSingle();
  const qh = (config?.quiet_hours || null) as QuietHoursConfig | null;
  if (!qh || !qh.enabled) return false;
  return evalQuietHours(qh, ts);
}

/**
 * Versão sync que recebe a config já lida — útil pro recurring-runner
 * que já tem agent_configs em mão.
 */
export function evalQuietHours(qh: QuietHoursConfig, ts: Date = new Date()): boolean {
  const tz = qh.timezone || "America/New_York";
  const start = qh.start || "22:00";
  const end = qh.end || "07:00";
  const days = qh.days || [0, 1, 2, 3, 4, 5, 6];

  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(ts);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    const weekday = WEEKDAY_MAP[get("weekday")] ?? 0;
    if (!days.includes(weekday)) return false;
    const hour = parseInt(get("hour")) || 0;
    const minute = parseInt(get("minute")) || 0;
    const nowMin = hour * 60 + minute;
    const [sH, sM] = start.split(":").map(Number);
    const [eH, eM] = end.split(":").map(Number);
    const startMin = sH * 60 + sM;
    const endMin = eH * 60 + eM;
    // Janela cross-midnight (ex: 22h-7h) → start > end
    if (startMin > endMin) return nowMin >= startMin || nowMin <= endMin;
    return nowMin >= startMin && nowMin <= endMin;
  } catch {
    return false;
  }
}

/* ── F32 (Pedro 2026-05-28) — working_hours também ──────────────────
 * Antes deste módulo expandir, bulk/outreach só respeitava quiet_hours
 * (default 22-7). Working_hours (seg-sex 9-18) era IGNORADO no runner —
 * rep ligava "respeitar horário de atendimento" pensando que cortava
 * outreach pra dentro de 9-18 mas o cast em outreach-runner:111 virava
 * `respect_quiet_hours` apenas. Sábado às 8h = quiet_hours ok mas
 * working_hours OFF → outreach disparava.
 *
 * Agora: `isInBlockedHours()` combina quiet (rep silêncio noturno) +
 * working (janela formal de atendimento, com mode only_during/outside).
 * Bulk-runner chama essa em vez de só isInQuietHours.
 */

interface WorkingHoursDay {
  enabled?: boolean;
  start?: string;
  end?: string;
}
export interface WorkingHoursConfig {
  enabled?: boolean;
  timezone?: string;
  mode?: "only_during" | "only_outside";
  schedule?: Record<string, WorkingHoursDay>;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Versão sync: avalia se `ts` está FORA das working_hours do agente.
 * Retorna false se config disabled ou mal-formada (fail-open).
 */
export function evalOutsideWorkingHours(wh: WorkingHoursConfig, ts: Date = new Date()): boolean {
  if (!wh || !wh.enabled || !wh.schedule) return false;
  const tz = wh.timezone || "America/New_York";
  const mode = wh.mode || "only_during";
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(ts);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    const weekday = WEEKDAY_MAP[get("weekday")] ?? 0;
    const dayKey = WEEKDAY_NAMES[weekday];
    const day = wh.schedule[dayKey];
    if (!day || !day.enabled) {
      // Dia desligado = sempre "fora" se mode=only_during; sempre "dentro" se only_outside.
      return mode === "only_during";
    }
    const hour = parseInt(get("hour")) || 0;
    const minute = parseInt(get("minute")) || 0;
    const nowMin = hour * 60 + minute;
    const [sH, sM] = (day.start || "09:00").split(":").map(Number);
    const [eH, eM] = (day.end || "18:00").split(":").map(Number);
    const startMin = sH * 60 + sM;
    const endMin = eH * 60 + eM;
    const inWindow = nowMin >= startMin && nowMin <= endMin;
    return mode === "only_during" ? !inWindow : inWindow;
  } catch {
    return false;
  }
}

/**
 * Async: combina quiet_hours + working_hours. Bulk/outreach runner usa
 * essa em vez de só `isInQuietHours` (F32 fix).
 *
 * Retorna `blocked: true` se QUALQUER um dos dois está bloqueado, com
 * o reason específico. Fail-open em erro (preserva legacy behavior).
 */
export async function isInBlockedHours(
  agentId: string | null,
  ts: Date = new Date(),
): Promise<{ blocked: boolean; reason?: "quiet_hours" | "working_hours" }> {
  if (!agentId) return { blocked: false };
  const supabase = createAdminClient();
  const { data: config } = await supabase
    .from("agent_configs")
    .select("quiet_hours, working_hours")
    .eq("agent_id", agentId)
    .maybeSingle();
  const qh = (config?.quiet_hours || null) as QuietHoursConfig | null;
  const wh = (config?.working_hours || null) as WorkingHoursConfig | null;
  if (qh?.enabled && evalQuietHours(qh, ts)) {
    return { blocked: true, reason: "quiet_hours" };
  }
  if (wh?.enabled && evalOutsideWorkingHours(wh, ts)) {
    return { blocked: true, reason: "working_hours" };
  }
  return { blocked: false };
}
