/**
 * Guarda determinística weekday↔data (H50, fix bug prod caso Caua 2026-07-15).
 *
 * O bug: o LLM recebe a data de hoje CERTA no prompt ("[Agora: quarta-feira,
 * 15/07/2026...]"), mas quando o rep pede um dia NOMEADO ("segunda-feira 20h")
 * o LLM calcula a data por ARITMÉTICA e às vezes erra (off-by-one / semana
 * errada). Como `create_appointment` recebe `start_time` como ISO 8601 que o
 * PRÓPRIO LLM computa (e só valida o formato), o ISO errado entrava cru → a
 * reunião ia pro DIA ERRADO de verdade (não era só o rótulo). Ex real: "segunda"
 * virou 14/07 (que é terça); "quarta" virou 16/07 (que é quinta).
 *
 * O fix (padrão anti-alucinação H41/H45 — a tool devolve o ESTADO REAL): o
 * servidor computa o weekday REAL do `start_time` no fuso do rep e cruza com o
 * dia que o REP nomeou (`expected_weekday`). Se não bater, REJEITA com a
 * correção exata (weekday real da data + próxima data daquele dia). O confirm
 * também passa a mostrar um rótulo COMPUTADO por código, não pelo LLM.
 *
 * Tudo puro/testável (sem I/O). Fuso via Intl (DST-correct).
 */

const WD_LONG_PT = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

/** Remove acentos (NFD + strip combining) pra casar "terça"/"terca"/"sabado". */
function deburr(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Interpreta o que o rep/LLM falou → índice 0..6 (Dom..Sáb). Aceita PT
 * ("segunda", "segunda-feira", "seg", "2a"), EN ("monday", "mon") e variações
 * sem acento. Retorna null se não reconhecer (ex: "amanhã", data explícita).
 */
export function parseWeekdayPt(raw: string): number | null {
  if (!raw) return null;
  const s = deburr(String(raw).toLowerCase().trim());
  const table: Record<string, number> = {
    domingo: 0, dom: 0, sunday: 0, sun: 0, "1a": 0,
    segunda: 1, "segunda-feira": 1, seg: 1, monday: 1, mon: 1, "2a": 1,
    terca: 2, "terca-feira": 2, ter: 2, tuesday: 2, tue: 2, "3a": 2,
    quarta: 3, "quarta-feira": 3, qua: 3, wednesday: 3, wed: 3, "4a": 3,
    quinta: 4, "quinta-feira": 4, qui: 4, thursday: 4, thu: 4, "5a": 4,
    sexta: 5, "sexta-feira": 5, sex: 5, friday: 5, fri: 5, "6a": 5,
    sabado: 6, "sabado-feira": 6, sab: 6, saturday: 6, sat: 6, "7a": 6,
  };
  if (s in table) return table[s];
  // prefixo ("segunda de manhã", "quarta que vem")
  for (const key of Object.keys(table)) {
    if (key.length >= 3 && s.startsWith(key)) return table[key];
  }
  return null;
}

/** Weekday REAL (0..6) do instante ISO no fuso dado. null se ISO/tz inválido. */
export function weekdayOfIso(iso: string, tz: string): number | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? null;
  } catch {
    return null;
  }
}

/** Nome longo PT do índice 0..6 ("segunda-feira"). */
export function weekdayNamePt(idx: number): string {
  return WD_LONG_PT[idx] ?? "?";
}

/** Extrai {y,m,d} do instante NO fuso dado (calendário local, não UTC). */
function ymdInTz(d: Date, tz: string): { y: number; m: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    const y = parseInt(get("year") || "", 10);
    const m = parseInt(get("month") || "", 10);
    const day = parseInt(get("day") || "", 10);
    if (isNaN(y) || isNaN(m) || isNaN(day)) return null;
    return { y, m, day };
  } catch {
    return null;
  }
}

/**
 * Próxima data (>= hoje no fuso) cujo weekday = target. Aritmética em dias
 * inteiros via Date.UTC (DST-immune — só desloca dias de calendário).
 * Retorna "DD/MM/AAAA" ou null se algo falhar. `now` default = agora.
 */
export function nextDateForWeekday(targetWd: number, tz: string, now: Date = new Date()): string | null {
  const today = ymdInTz(now, tz);
  if (!today) return null;
  const todayWd = weekdayOfIso(now.toISOString(), tz);
  if (todayWd === null) return null;
  const delta = (((targetWd - todayWd) % 7) + 7) % 7; // 0..6 (0 = hoje)
  const base = Date.UTC(today.y, today.m - 1, today.day);
  const target = new Date(base + delta * 86400000);
  const dd = String(target.getUTCDate()).padStart(2, "0");
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${target.getUTCFullYear()}`;
}

/**
 * Rótulo determinístico "quinta-feira, 16/07/2026 às 20:00" a partir do ISO,
 * no fuso do rep. É o que o bot DEVE narrar no confirm (não recalcular).
 */
export function formatWeekdayDate(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const wd = weekdayOfIso(iso, tz);
  if (wd === null) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    const hh = get("hour") === "24" ? "00" : get("hour");
    return `${weekdayNamePt(wd)}, ${get("day")}/${get("month")}/${get("year")} às ${hh}:${get("minute")}`;
  } catch {
    return null;
  }
}

export interface WeekdayGuardResult {
  ok: boolean;
  /** Mensagem de correção pro LLM (quando ok=false). */
  message?: string;
}

/**
 * Cruza o dia-da-semana que o REP nomeou com o weekday REAL de `startIso` no
 * fuso do rep. `expectedRaw` = a palavra que o rep falou ("segunda-feira").
 *
 * - Se `expectedRaw` não é um dia-da-semana reconhecível (data explícita,
 *   "amanhã", vazio) → ok:true (nada a validar, não bloqueia).
 * - Se bate → ok:true.
 * - Se não bate → ok:false + mensagem com weekday real da data informada,
 *   hoje, e a próxima data daquele dia-da-semana (grounding máximo pro LLM).
 */
export function checkWeekdayMatchesDate(
  startIso: string,
  expectedRaw: string,
  tz: string,
  now: Date = new Date(),
): WeekdayGuardResult {
  const expected = parseWeekdayPt(expectedRaw);
  if (expected === null) return { ok: true }; // não é dia nomeado → não valida
  const realWd = weekdayOfIso(startIso, tz);
  if (realWd === null) return { ok: true }; // ISO inválido já é pego por validateIso8601
  if (realWd === expected) return { ok: true };

  // Não bateu — monta correção determinística.
  const dateLabel = formatWeekdayDate(startIso, tz)?.split(" às ")[0] || startIso;
  const todayIso = now.toISOString();
  const todayWd = weekdayOfIso(todayIso, tz);
  const todayYmd = ymdInTz(now, tz);
  const todayLabel =
    todayWd !== null && todayYmd
      ? `${weekdayNamePt(todayWd)}, ${String(todayYmd.day).padStart(2, "0")}/${String(todayYmd.m).padStart(2, "0")}/${todayYmd.y}`
      : "hoje";
  const nextForExpected = nextDateForWeekday(expected, tz, now);

  return {
    ok: false,
    message:
      `⚠️ A data não bate com o dia-da-semana. Você passou start_time numa data que é ${dateLabel} ` +
      `— mas o rep pediu ${weekdayNamePt(expected)}. Hoje é ${todayLabel}. ` +
      `A próxima ${weekdayNamePt(expected)} é ${nextForExpected || "?"}. ` +
      `Confirme com o rep qual data ele quis (esta semana ou a próxima) e re-chame com start_time NESSA data, ` +
      `mantendo a hora. NÃO invente a data — use a que corresponde ao dia-da-semana que o rep falou.`,
  };
}
