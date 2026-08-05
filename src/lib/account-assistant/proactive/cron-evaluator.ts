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

/**
 * "Esse cron já venceu HOJE e ainda está dentro da janela de tolerância?"
 *
 * Fix bug observado em prod 2026-08-05: `shouldFireCron` só é verdadeiro durante
 * o MINUTO exato do cron. O loop de regras scheduled percorre os reps em série e
 * cada rep custa segundos (calls no Spark Leads + LLM), então o "Resumo matinal"
 * (`0 8 * * 1-5`) só alcançava quem coubesse dentro dos 60 segundos: 15 de 43
 * reps num dia bom, 1 em 30/07. No histórico de `assistant_alert_state` NENHUM
 * disparo passa de :01:01 depois da hora cheia — o teto é o fim do minuto.
 *
 * A tolerância troca a corrida por um intervalo: o tick seguinte continua de
 * onde o anterior parou. Quem já recebeu é barrado pelo dedup diário de
 * `assistant_alert_state` — a janela não duplica envio, só para de perder.
 *
 * Só olha minutos do MESMO dia local: um briefing das 8h não pode chegar de
 * madrugada do dia seguinte.
 */
export function isCronDue(
  cron: string,
  timezone: string,
  graceMinutes: number,
  now: Date = new Date(),
): boolean {
  const hoje = localDayKey(now, timezone);
  if (!hoje) return false;
  const passos = Math.max(0, Math.floor(graceMinutes));
  for (let i = 0; i <= passos; i++) {
    const candidato = new Date(now.getTime() - i * 60_000);
    // Cruzou a meia-noite local: o que venceu ontem não é mais "de hoje".
    if (localDayKey(candidato, timezone) !== hoje) break;
    if (shouldFireCron(cron, timezone, candidato)) return true;
  }
  return false;
}

/** Data local (YYYY-MM-DD) no fuso — usado pra travar a janela no dia corrente. */
function localDayKey(date: Date, timezone: string): string | null {
  const fmt = dayFormatter(timezone);
  if (!fmt) return null;
  return fmt.format(date);
}

// Construir Intl.DateTimeFormat é caro e estes dois são chamados em laço:
// `isCronDue` varre até 181 minutos por rep e `computeNextRunAt` até 144k.
// O formatter é imutável, então cachear por fuso é seguro. `null` no cache
// memoriza fuso inválido (não adianta tentar de novo).
const dayFmtCache = new Map<string, Intl.DateTimeFormat | null>();
const partsFmtCache = new Map<string, Intl.DateTimeFormat | null>();

function dayFormatter(timezone: string): Intl.DateTimeFormat | null {
  if (dayFmtCache.has(timezone)) return dayFmtCache.get(timezone) ?? null;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    fmt = null;
  }
  dayFmtCache.set(timezone, fmt);
  return fmt;
}

function partsFormatter(timezone: string): Intl.DateTimeFormat | null {
  if (partsFmtCache.has(timezone)) return partsFmtCache.get(timezone) ?? null;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    fmt = null;
  }
  partsFmtCache.set(timezone, fmt);
  return fmt;
}

function parseLocalParts(date: Date, timezone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  weekday: number;
} | null {
  try {
    const fmt = partsFormatter(timezone);
    if (!fmt) return null;
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

/**
 * Computa o próximo disparo de uma cron expression a partir de `from`.
 * Etapa 4.5 (Pedro 2026-05-28): usado pelo recurring-runner pra setar
 * next_run_at de recurring_campaigns após criação ou após cada disparo.
 *
 * Implementação: itera minuto-a-minuto até MAX_LOOKAHEAD_MINUTES (default
 * 100 dias). Retorna null se não achar match (cron inválido ou impossível).
 *
 * Performance: 100 dias × 24h × 60min = 144k iterações no pior caso —
 * irrelevante pra cron tick (~50ms numa máquina fraca).
 */
const MAX_LOOKAHEAD_MINUTES = 100 * 24 * 60;

export function computeNextRunAt(
  cron: string,
  timezone: string,
  from: Date = new Date(),
): Date | null {
  // Avança 1 minuto pra evitar dar match no minuto atual (queremos PRÓXIMO).
  const start = new Date(from.getTime() + 60_000);
  // Zera segundos/ms pra alinhar com tick minute-precision.
  start.setUTCSeconds(0, 0);
  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (shouldFireCron(cron, timezone, candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Conveniência: gera próximas N execuções (pra preview na UI do wizard).
 */
export function previewNextRuns(
  cron: string,
  timezone: string,
  count: number = 5,
  from: Date = new Date(),
): Date[] {
  const runs: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = computeNextRunAt(cron, timezone, cursor);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
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
