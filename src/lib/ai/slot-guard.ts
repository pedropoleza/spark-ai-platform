/**
 * Guard determinístico de booking lead-facing (H58, caso Alves Cury 2026-07-29).
 *
 * Bug observado em prod 2026-07-23/28 (agentes Bruna/Bruno da Alves Cury): o
 * modelo emitia `book_appointment` com start_time que o lead NUNCA escolheu (numa
 * mensagem que dizia "deixa eu ver a agenda"...), e nada validava o horário contra
 * os free-slots reais buscados no turno. Mesma classe do caso Manuela (H42) e da
 * pendência "weekday-guard lead-facing" (H50): a defesa por prompt não basta.
 *
 * Este guard fecha o furo em CÓDIGO: o start_time de book/reschedule só passa se
 * bater (tolerância 60s) com um slot da lista REAL injetada no prompt do turno.
 * Fora da lista → erro com "horario indisponivel" (bate em BOOKING_CONFLICT_
 * KEYWORDS de isBookingConflictError) → o action-executor troca a resposta do
 * modelo pela correção honesta ("não consegui agendar nesse horário...") — sem
 * booking fantasma E sem falsa confirmação ao lead.
 *
 * PURO, sem I/O. `offered === undefined` = caller não threadou a lista (rotas
 * legadas/sem calendário) → permite (back-compat); `[]` = fetch falhou ou agenda
 * sem slots → bloqueia (o runtime já proibiu booking nesse turno).
 */

/** Extrai a lista ISO crua do response do GHL free-slots (mesmo walk do formatAvailableSlots). */
export function extractSlotIsoList(slotsResp: Record<string, unknown> | null | undefined): string[] {
  if (!slotsResp || typeof slotsResp !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(slotsResp)) {
    if (key === "traceId" || !value) continue;
    let slots: string[] = [];
    if (typeof value === "object" && value !== null) {
      const v = value as Record<string, unknown>;
      if (Array.isArray(v.slots)) slots = v.slots as string[];
      else if (Array.isArray(value)) slots = value as string[];
    }
    for (const s of slots) if (typeof s === "string" && s) out.push(s);
  }
  return out;
}

export type SlotValidation = { ok: true } | { ok: false; reason: string };

/** Offset (minutos, local−UTC) de um instante num timezone IANA — DST-correct via Intl. */
function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - utcMs) / 60_000;
}

/**
 * H66 (fix bug observado em prod 2026-08-04, caso +1 267 746 / Five Star): o LLM
 * FALA o horário certo pro lead ("1:00 PM ET") mas às vezes emite o ISO com
 * offset ERRADO (-03:00, Brasília) → a reunião cai 1h deslocada na agenda, e o
 * guard H58 não pega quando o instante deslocado coincide com OUTRO slot livre
 * (ele valida "é um slot real", não "é o slot que você falou"). Mesma classe do
 * H50 (weekday) — a defesa por prompt não basta.
 *
 * Correção determinística: o WALL-CLOCK do ISO é a intenção (é o que o LLM
 * falou); o offset é descartado e recalculado pro fuso da CONTA (DST-aware).
 * "2026-08-04T13:00:00-03:00" em America/New_York → "2026-08-04T13:00:00-04:00".
 * ISO sem offset ou com Z recebe o mesmo tratamento (wall-clock no fuso da
 * conta). ISO não-parseável passa intocado (o slot-guard rejeita depois).
 * PURO, sem I/O.
 */
export function coerceStartTimeToTimezone(
  iso: string | undefined | null,
  timeZone: string,
  offeredSlotsIso?: string[],
): { iso: string; coerced: boolean; original?: string; offsetSource?: "slots" | "location" } {
  const raw = String(iso ?? "");
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return { iso: raw, coerced: false };
  const [, Y, Mo, D, H, Mi, S] = m;
  const wallAsUtc = Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S || 0));
  // H73 (fix bug observado em prod 2026-08-07, caso Márcia/Five Star): o offset
  // de destino vem dos FREE-SLOTS REAIS do turno quando eles existem, e só cai
  // pro fuso da location quando não há slots. Motivo: `locations.timezone` é
  // dado de cadastro e pode estar ERRADO (H72 achou 43 contas assim, esta entre
  // elas) — e coagir contra uma fonte errada reproduz o erro com fidelidade: a
  // IA falava "7:00 PM (ET)" e gravava 19:00-03:00, que é 6 PM ET. Os slots vêm
  // do calendário que vai RECEBER a reunião, então são a fonte que decide.
  // Mantém a correção original do H66 (LLM emite offset de outro fuso): o
  // wall-clock continua sendo a intenção, só o offset é recalculado.
  const offFromSlots = offsetMinutesFromSlots(offeredSlotsIso, `${Y}-${Mo}-${D}`);
  let off: number;
  if (offFromSlots !== null) {
    off = offFromSlots;
  } else {
    // 2 passadas convergem o offset pro wall-clock (borda de DST inclusa).
    off = zoneOffsetMinutes(wallAsUtc, timeZone);
    off = zoneOffsetMinutes(wallAsUtc - off * 60_000, timeZone);
  }
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const out = `${Y}-${Mo}-${D}T${H}:${Mi}:${S || "00"}${offStr}`;
  const origInstant = Date.parse(raw);
  const coerced = Number.isNaN(origInstant) || Date.parse(out) !== origInstant;
  const offsetSource = offFromSlots !== null ? ("slots" as const) : ("location" as const);
  return coerced
    ? { iso: out, coerced: true, original: raw, offsetSource }
    : { iso: out, coerced: false, offsetSource };
}

/**
 * Offset (minutos) que o calendário REAL usa no dia `yyyy-mm-dd`, lido dos
 * free-slots do turno. Só devolve valor quando os slots daquele dia concordam
 * entre si — divergência (agenda multi-fuso) devolve null e o caller cai pro
 * fuso da location. Sem slots do dia pedido, tenta o offset predominante da
 * lista inteira: dentro de uma janela de dias o offset só muda na virada de
 * DST, e a concordância unânime é a checagem. PURO.
 */
export function offsetMinutesFromSlots(
  offered: string[] | undefined | null,
  isoDate?: string,
): number | null {
  if (!offered || offered.length === 0) return null;
  const parse = (s: string): number | null => {
    const m = String(s).match(/T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/);
    if (!m) return null;
    if (m[1] === "Z") return 0;
    const mm = m[1].replace(":", "");
    const sign = mm[0] === "-" ? -1 : 1;
    return sign * (Number(mm.slice(1, 3)) * 60 + Number(mm.slice(3, 5)));
  };
  const doDia = isoDate ? offered.filter((s) => String(s).startsWith(isoDate)) : [];
  for (const grupo of [doDia, offered]) {
    const offs = grupo.map(parse).filter((n): n is number => n !== null);
    if (offs.length === 0) continue;
    if (offs.every((o) => o === offs[0])) return offs[0];
  }
  return null;
}

/**
 * Normaliza o `startTime` que o Spark Leads devolve nos appointments.
 *
 * Fix bug observado em prod 2026-08-07 (H73, caso Nery/Five Star): o endpoint
 * `/contacts/{id}/appointments` devolve wall-clock SEM offset e sem "T"
 * ("2026-08-12 18:00:00"), no fuso do calendário. `Date.parse` disso usa o fuso
 * do PROCESSO — que em produção é UTC — então comparar com o ISO do booking
 * ("...T18:00:00-04:00") dava 4h de diferença e o check de duplicata NUNCA
 * batia. Era esse o motivo de o escape idempotente (H61) nunca ter salvado um
 * caso real: ele não estava sutilmente errado, estava morto em prod. Localmente
 * passava despercebido porque a máquina do dev roda em ET.
 *
 * Valor com offset explícito (ou Z) passa intocado. PURO.
 */
export function normalizeCrmStartTime(
  raw: string | undefined | null,
  timeZone: string,
  offeredSlotsIso?: string[],
): string {
  const s = String(raw ?? "").trim();
  if (!s) return s;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return s;
  const comT = s.includes("T") ? s : s.replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(comT)) return s;
  return coerceStartTimeToTimezone(comT, timeZone, offeredSlotsIso).iso;
}

/**
 * Dois ISO representam o MESMO instante (tolerância 60s, igual ao guard)?
 * H61 (caso Adriana/Five Star 2026-08-01): usado pra reconhecer que o slot
 * "indisponível" é o appointment que o PRÓPRIO contato acabou de ganhar num
 * turno anterior da rajada — aí é duplicata, não conflito real.
 */
export function isSameSlotInstant(
  aIso: string | undefined | null,
  bIso: string | undefined | null,
  toleranceMs = 60_000,
): boolean {
  const a = Date.parse(String(aIso ?? ""));
  const b = Date.parse(String(bIso ?? ""));
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) < toleranceMs;
}

/**
 * start_time é um dos slots oferecidos? Compara por EPOCH (tolerância 60s) —
 * imune a representação de offset diferente (ex: -04:00 vs Z do mesmo instante).
 * Um wall-clock errado (fuso trocado, dia errado) NÃO bate → bloqueia (é
 * exatamente o bug H42/H50 que queremos parar).
 */
export function validateBookingSlot(
  startTime: string | undefined | null,
  offered: string[] | undefined,
): SlotValidation {
  if (!startTime) return { ok: true }; // sem start_time o executor nem tenta agendar
  if (offered === undefined) return { ok: true }; // caller não threadou (back-compat)
  const t = Date.parse(startTime);
  if (Number.isNaN(t)) {
    return { ok: false, reason: `start_time invalido ("${String(startTime).slice(0, 40)}") — horario indisponivel` };
  }
  const TOLERANCE_MS = 60_000;
  for (const s of offered) {
    const e = Date.parse(s);
    if (!Number.isNaN(e) && Math.abs(e - t) < TOLERANCE_MS) return { ok: true };
  }
  return {
    ok: false,
    reason:
      offered.length === 0
        ? "agenda sem slots disponiveis neste turno — horario indisponivel (guard H58)"
        : `start_time ${startTime} nao esta na lista de ${offered.length} horarios reais do turno — horario indisponivel (guard H58)`,
  };
}
