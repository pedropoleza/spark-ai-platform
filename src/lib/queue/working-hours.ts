/**
 * Expediente do agente lead-facing (`agent_configs.working_hours`).
 *
 * Movido do webhook de inbound (H102, 2026-10-07) pra ser usado também pelo
 * gatilho de lead novo (`OpportunityCreate`), que precisa da MESMA resposta:
 * "estamos no expediente? se não, quando abre?". Lógica idêntica à que estava
 * no route; só ganhou o `agora` opcional pra dar pra testar.
 */

import type { WorkingHoursConfig } from "@/types/agent";

export function isWithinWorkingHours(wh: WorkingHoursConfig, agora: Date = new Date()): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: wh.timezone || "America/New_York",
    weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = formatter.formatToParts(agora);
  const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase() || "";
  const hour = parts.find((p) => p.type === "hour")?.value || "0";
  const minute = parts.find((p) => p.type === "minute")?.value || "0";
  const currentMinutes = parseInt(hour) * 60 + parseInt(minute);

  const dayConfig = wh.schedule[weekday];
  if (!dayConfig || !dayConfig.enabled) return wh.mode === "only_outside";

  const [startH, startM] = dayConfig.start.split(":").map(Number);
  const [endH, endM] = dayConfig.end.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  // Janela noturna (start>end, ex: 22h–6h) "dá a volta" na meia-noite.
  // Fix ultra-review 2026-05-26: antes start>end nunca era "dentro" → agente mudo.
  const isDuringHours =
    startMin <= endMin
      ? currentMinutes >= startMin && currentMinutes <= endMin
      : currentMinutes >= startMin || currentMinutes <= endMin;

  return wh.mode === "only_during" ? isDuringHours : !isDuringHours;
}

/**
 * Calcula próximo timestamp ISO em que estaremos dentro de working hours
 * (no tz da location). Usado pra enfileirar msgs recebidas fora do expediente
 * com process_after = next_work_window_start, em vez de dropar silenciosamente.
 *
 * Fix HIGH-13 (deep review 2026-05-05): antes, msg fora do expediente era
 * skipped sem persistir nada → lead nunca recebia resposta. Agora enfileira
 * pro próximo expediente. Cap em 7 dias pra evitar runaway se schedule é
 * inconsistente (ex: todos dias disabled).
 *
 * Returns null se não conseguir achar janela em 7 dias.
 */
export function nextWorkingHourStart(wh: WorkingHoursConfig, agora: Date = new Date()): string | null {
  const tz = wh.timezone || "America/New_York";
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const target = new Date(agora.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(target);
    const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase() || "";
    const dayConfig = wh.schedule[weekday];
    if (!dayConfig || !dayConfig.enabled) continue;
    if (dayNames.indexOf(weekday) < 0) continue;

    const [startH, startM] = dayConfig.start.split(":").map(Number);
    const [endH, endM] = dayConfig.end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    const dayHour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");
    const dayMinute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
    const dayCurrentMinutes = dayOffset === 0 ? dayHour * 60 + dayMinute : 0;

    // Se ainda não passou da janela hoje, agenda pra start ou agora (o que for maior)
    if (dayCurrentMinutes < endMinutes) {
      const targetMinutes = Math.max(startMinutes, dayCurrentMinutes);
      const yyyy = parts.find((p) => p.type === "year")?.value || "";
      const mm = parts.find((p) => p.type === "month")?.value || "";
      const dd = parts.find((p) => p.type === "day")?.value || "";
      // Constrói ISO no tz e converte pra UTC. Não preciso de precisão DST
      // pra esse caso — usar Date.parse com tz hint é suficiente.
      const targetDate = new Date(`${yyyy}-${mm}-${dd}T${String(Math.floor(targetMinutes / 60)).padStart(2, "0")}:${String(targetMinutes % 60).padStart(2, "0")}:00`);
      // Ajusta pra tz: comparar offset entre tz e local
      const tzOffset = (() => {
        const tzFmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tz, hour12: false,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
        });
        const sample = new Date(targetDate.getTime());
        const sampleParts = tzFmt.formatToParts(sample);
        const get = (t: string) => parseInt(sampleParts.find((p) => p.type === t)?.value || "0");
        return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - sample.getTime();
      })();
      return new Date(targetDate.getTime() - tzOffset).toISOString();
    }
  }
  return null;
}
