/**
 * Avaliador de cron expressions simples.
 *
 * Suporta apenas o subset que usamos em scheduled rules:
 *   - minuto: número (0-59)
 *   - hora: número (0-23)
 *   - dia do mês: * apenas
 *   - mês: * apenas
 *   - dia da semana: número, lista (1,3,5), ou range (1-5)
 *
 * Exemplos válidos:
 *   "0 8 * * 1-5"  → segunda a sexta às 08:00
 *   "0 17 * * 5"   → sexta às 17:00
 *   "30 9 * * 1,3" → segunda e quarta às 09:30
 *
 * Retorna true se o cron deve disparar AGORA (no minuto atual, no timezone).
 */

export function shouldFireCron(cron: string, timezone: string, now: Date = new Date()): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minStr, hourStr, , , dowStr] = parts;

  const target = parseLocalParts(now, timezone);
  if (!target) return false;

  if (!matchField(minStr, target.minute, 0, 59)) return false;
  if (!matchField(hourStr, target.hour, 0, 23)) return false;
  // dia do mês e mês ignorados (sempre *)
  if (!matchField(dowStr, target.weekday, 0, 6)) return false;

  return true;
}

function parseLocalParts(date: Date, timezone: string): { minute: number; hour: number; weekday: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[get("weekday")];
    if (weekday === undefined) return null;
    return {
      minute: parseInt(get("minute")) || 0,
      hour: parseInt(get("hour")) || 0,
      weekday,
    };
  } catch {
    return null;
  }
}

function matchField(field: string, value: number, _min: number, _max: number): boolean {
  if (field === "*") return true;
  // Lista: "1,3,5"
  if (field.includes(",")) {
    return field.split(",").some((part) => matchField(part, value, _min, _max));
  }
  // Range: "1-5"
  if (field.includes("-")) {
    const [s, e] = field.split("-").map((x) => parseInt(x));
    return value >= s && value <= e;
  }
  // Número simples
  const n = parseInt(field);
  return !isNaN(n) && n === value;
}
