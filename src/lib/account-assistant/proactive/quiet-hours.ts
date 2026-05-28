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
