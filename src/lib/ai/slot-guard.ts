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
