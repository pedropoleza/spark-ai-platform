/**
 * Avaliador de cron expressions com 5 campos (POSIX-style):
 *   minuto (0-59) | hora (0-23) | dia do mês (1-31) | mês (1-12) | dow (0-6)
 *
 * Suporta `*`, número, lista `1,3,5`, e range `1-5`. Não suporta steps `*\/n`.
 *
 * Exemplos:
 *   "0 8 * * 1-5"   → segunda a sexta às 08:00
 *   "0 17 * * 5"    → sexta às 17:00
 *   "0 9 1 * *"     → todo dia 1 do mês às 09:00
 *   "0 9 1 1 *"     → 1 de janeiro às 09:00
 *   "30 9 * * 1,3"  → segunda e quarta às 09:30
 *
 * Retorna true se o cron deve disparar AGORA (no minuto atual, no timezone).
 */

export function shouldFireCron(cron: string, timezone: string, now: Date = new Date()): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minStr, hourStr, domStr, monStr, dowStr] = parts;

  const target = parseLocalParts(now, timezone);
  if (!target) return false;

  if (!matchField(minStr, target.minute, 0, 59)) return false;
  if (!matchField(hourStr, target.hour, 0, 23)) return false;
  if (!matchField(monStr, target.month, 1, 12)) return false;

  // Cron POSIX: se dom E dow forem ambos especificados (não *), é OR (qualquer um match dispara).
  // Se um for * e outro especificado, só o especificado importa.
  const domIsAny = domStr === "*";
  const dowIsAny = dowStr === "*";

  if (domIsAny && dowIsAny) return true; // ambos *
  if (domIsAny) return matchField(dowStr, target.weekday, 0, 6);
  if (dowIsAny) return matchField(domStr, target.dayOfMonth, 1, 31);
  // Ambos especificados: OR
  return (
    matchField(domStr, target.dayOfMonth, 1, 31) ||
    matchField(dowStr, target.weekday, 0, 6)
  );
}

function parseLocalParts(date: Date, timezone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  weekday: number;
} | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
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
      dayOfMonth: parseInt(get("day")) || 1,
      month: parseInt(get("month")) || 1,
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
