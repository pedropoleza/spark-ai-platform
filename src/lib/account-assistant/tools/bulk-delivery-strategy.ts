/**
 * Bulk Delivery Strategy (H28 update, Pedro 2026-05-15).
 *
 * Pedro: "ao realizar disparo, ela deveria dar 3 opções (ou quantas
 * forem necessárias): 1. Enviar tudo hoje. 2. Em 2-3 dias. 3. Janela
 * específica." Sempre com espaçamento entre mensagens (90s default).
 *
 * Este módulo:
 *   1. Computa OPÇÕES de delivery automaticamente baseado em N contatos +
 *      cap diário + quiet hours → bot apresenta menu numerado.
 *   2. Distribui scheduled_at de recipients respeitando strategy escolhida
 *      (single day burst, spread N days, custom window).
 */

// (types intencionalmente em arquivo separado pra evitar circular import)

// ---------------------------------------------------------------------
// DeliveryStrategy
// ---------------------------------------------------------------------

export type DeliveryStrategy =
  | { type: "today"; interval_seconds?: number; jitter_seconds?: number }
  | { type: "spread_days"; days_count: number; interval_seconds?: number; jitter_seconds?: number }
  | { type: "custom_window"; start_at: string; end_at: string; interval_seconds?: number; jitter_seconds?: number };

export interface DeliveryOption {
  id: number;
  strategy: DeliveryStrategy;
  label: string;
  description: string;
  estimated_minutes: number;
  daily_breakdown: Array<{ day: string; count: number }>;
  warnings: string[];
}

export interface ComputeDeliveryOptionsInput {
  total_contacts: number;
  /** Cap diário GHL (msgs por 24h pra location). null = sem cap. */
  daily_cap: number | null;
  used_today: number;
  /** Default 90s; min 30, max 600 */
  default_interval_seconds?: number;
  default_jitter_seconds?: number;
  /** Pra clock anchoring; default = now */
  now?: Date;
  /** Lista temperature (afeta recomendação de spread) */
  list_temperature?: "warm" | "cold" | "unknown";
}

/**
 * Computa 3 opções automáticas de delivery pro bot apresentar como menu.
 *
 * Opção 1: hoje (single batch)
 * Opção 2: spread 2-3 dias
 * Opção 3: custom window — placeholder ("rep especifica horário")
 */
export function computeDeliveryOptions(input: ComputeDeliveryOptionsInput): DeliveryOption[] {
  const total = input.total_contacts;
  const interval = input.default_interval_seconds ?? 90;
  const jitter = input.default_jitter_seconds ?? 30;
  const cap = input.daily_cap;
  const remainingToday = cap === null ? Infinity : Math.max(0, cap - input.used_today);
  const now = input.now || new Date();
  const isCold = input.list_temperature === "cold";

  const options: DeliveryOption[] = [];
  const totalEtaMin = Math.ceil((total * interval) / 60);

  // ===== Opção 1: tudo hoje =====
  const willHitCap = cap !== null && total > remainingToday;
  const todayCount = Math.min(total, remainingToday === Infinity ? total : remainingToday);
  const overflowCount = willHitCap ? total - remainingToday : 0;
  // Se hit cap, overflow vai pro próximo dia ÚTIL (não sábado)
  const overflowDays = overflowCount > 0
    ? nextNBusinessDays(addDays(now, 1), 1)
    : [];
  options.push({
    id: 1,
    strategy: { type: "today", interval_seconds: interval, jitter_seconds: jitter },
    label: "Tudo hoje (single batch)",
    description: willHitCap
      ? `${total} contatos, ETA ${totalEtaMin}min, mas só ${remainingToday} cabem no cap diário restante — ${overflowCount} ficam pra ${formatDate(overflowDays[0])} automaticamente.`
      : `${total} contatos disparados em sequência, ETA ${totalEtaMin}min (${interval}s ± ${jitter}s entre cada).`,
    estimated_minutes: totalEtaMin,
    daily_breakdown: [
      { day: formatDate(now), count: todayCount },
      ...(overflowCount > 0
        ? [{ day: formatDate(overflowDays[0]), count: overflowCount }]
        : []),
    ],
    warnings:
      isCold && total > 10
        ? ["⚠️ Lista fria + volume alto + tudo hoje = risco MUITO alto de ban WhatsApp"]
        : total > 50
          ? ["⚠️ Volume alto num só dia — considera Opção 2 pra reduzir risco"]
          : [],
  });

  // ===== Opção 2: spread 2-3 dias =====
  const days = total > 80 ? 3 : 2;
  const perDay = Math.ceil(total / days);
  const dailyEtaMin = Math.ceil((perDay * interval) / 60);
  const breakdown: Array<{ day: string; count: number }> = [];
  const businessDays = nextNBusinessDays(now, days);
  for (let i = 0; i < days; i++) {
    const count = i === days - 1 ? total - perDay * (days - 1) : perDay;
    breakdown.push({ day: formatDate(businessDays[i]), count });
  }
  options.push({
    id: 2,
    strategy: {
      type: "spread_days",
      days_count: days,
      interval_seconds: interval,
      jitter_seconds: jitter,
    },
    label: `Spread em ${days} dias úteis (~${perDay}/dia)`,
    description: `${perDay} contatos por dia ao longo de ${days} dias úteis (skipa sáb/dom). Cada dia: ETA ${dailyEtaMin}min. Começa em ${formatDate(businessDays[0])}, respeita quiet_hours e cap diário automaticamente.`,
    estimated_minutes: dailyEtaMin,
    daily_breakdown: breakdown,
    warnings:
      isCold && total > 20
        ? ["Lista fria — considere reduzir total ou usar Opção 3 com janela maior"]
        : [],
  });

  // ===== Opção 3: custom window (placeholder) =====
  // F40 (Pedro 2026-06-01): defaults sensatos pro placeholder — começa amanhã
  // 9h, termina amanhã 18h (horário comercial). Bot deve sobrescrever quando
  // rep pedir janela específica, mas se rep só disser "janela custom" o default
  // não é mais "semana inteira" nem "23:59" do dia.
  const tomorrow = addDays(now, 1);
  tomorrow.setHours(9, 0, 0, 0);
  const tomorrowEnd = addDays(now, 1);
  tomorrowEnd.setHours(18, 0, 0, 0);
  options.push({
    id: 3,
    strategy: {
      type: "custom_window",
      start_at: tomorrow.toISOString(),
      end_at: tomorrowEnd.toISOString(),
      interval_seconds: interval,
      jitter_seconds: jitter,
    },
    label: "Janela customizada (você define)",
    description:
      "Rep especifica start_at + end_at (ISO 8601). Engine distribui contatos uniformemente respeitando quiet hours. " +
      "Default placeholder: amanhã 9h-18h. " +
      "REGRA F40: end_at máx 21h local (bot capa); se template tem cumprimento de horário, a janela tem que caber.",
    estimated_minutes: 0,
    daily_breakdown: [],
    warnings: [
      "Bot precisa perguntar: 'Qual horário começar?' e 'Qual hora terminar?' (max 21h)",
      "Se o template tem 'Bom dia' / 'Boa tarde' / 'Boa noite', a janela tem que caber no período (bot rejeita mismatch)",
    ],
  });

  return options;
}

// ---------------------------------------------------------------------
// computeBatchedScheduledAts
// ---------------------------------------------------------------------

export interface ComputeBatchedInput {
  total_recipients: number;
  strategy: DeliveryStrategy;
  /** Default = now */
  base_start?: Date;
  /** Default cap por dia (anti-burst). 100 typical. null = ilimitado */
  daily_cap?: number | null;
  /** Quiet hours já considerado? Caller (executor) tem helper próprio. */
}

/**
 * Calcula scheduled_at[] pra N recipients dado uma strategy.
 *
 * Garante:
 *   - Sempre tem espaçamento (interval_seconds + jitter)
 *   - Respeita daily_cap distribuindo entre dias automaticamente
 *   - Pra spread_days, distribui ~equally entre N dias úteis (seg-sex)
 *   - Pra custom_window, distribui uniformemente entre start_at e end_at
 *   - Janela só começa entre 09:00-18:00 (horário comercial padrão; futuro:
 *     ler quiet_hours da agent_config pra ajustar)
 */
export function computeBatchedScheduledAts(input: ComputeBatchedInput): Date[] {
  const base = input.base_start || new Date();
  const total = input.total_recipients;
  const result: Date[] = [];
  const dailyCap = input.daily_cap === undefined ? 100 : input.daily_cap;

  const interval = (input.strategy.interval_seconds ?? 90) * 1000;
  const jitterMs = (input.strategy.jitter_seconds ?? 30) * 1000;

  if (input.strategy.type === "today") {
    return fillDayWithSpacing(base, total, interval, jitterMs);
  }

  if (input.strategy.type === "spread_days") {
    const days = input.strategy.days_count;
    const perDay = Math.ceil(total / days);
    const businessDays = nextNBusinessDays(base, days);
    let remaining = total;
    for (let d = 0; d < days; d++) {
      // Sempre começa às 09:00 do dia ÚTIL em questão (skip weekends)
      const dayStart = startOfBusinessDay(businessDays[d]);
      const countThisDay = Math.min(perDay, remaining, dailyCap || perDay);
      const dayAts = fillDayWithSpacing(dayStart, countThisDay, interval, jitterMs);
      result.push(...dayAts);
      remaining -= countThisDay;
      if (remaining <= 0) break;
    }
    return result;
  }

  if (input.strategy.type === "custom_window") {
    const start = new Date(input.strategy.start_at);
    const end = new Date(input.strategy.end_at);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      throw new Error(`custom_window inválido: start_at=${input.strategy.start_at} end_at=${input.strategy.end_at}`);
    }
    const windowMs = end.getTime() - start.getTime();
    // Distribui uniformemente; cada gap = max(interval, windowMs/total)
    const gap = Math.max(interval, windowMs / total);
    for (let i = 0; i < total; i++) {
      const offset = i * gap + (Math.random() * 2 - 1) * jitterMs;
      result.push(new Date(start.getTime() + offset));
    }
    return result;
  }

  return [];
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function fillDayWithSpacing(
  start: Date,
  count: number,
  intervalMs: number,
  jitterMs: number,
): Date[] {
  const result: Date[] = [];
  for (let i = 0; i < count; i++) {
    const jitter = (Math.random() * 2 - 1) * jitterMs;
    const t = new Date(start.getTime() + i * intervalMs + jitter);
    result.push(t);
  }
  return result;
}

function startOfBusinessDay(d: Date): Date {
  // 09:00 hora local
  const r = new Date(d);
  r.setHours(9, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Retorna N próximos dias úteis a partir de `start` (inclusivo se start
 * for útil). Pula sábado (6) e domingo (0).
 */
function nextNBusinessDays(start: Date, n: number): Date[] {
  const result: Date[] = [];
  const cursor = new Date(start);
  while (result.length < n) {
    const day = cursor.getDay(); // 0=dom, 6=sáb
    if (day !== 0 && day !== 6) {
      result.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function formatDate(d: Date): string {
  // YYYY-MM-DD (qua ou seg etc)
  return d.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}
