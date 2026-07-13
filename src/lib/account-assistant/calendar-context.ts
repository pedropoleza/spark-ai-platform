/**
 * Contexto de agenda com BLOQUEIOS (H48, 2026-07-10).
 *
 * O `/calendars/events` só devolve appointments do CRM — compromissos do Google
 * Calendar (busy sync) vivem em `/calendars/blocked-slots` e o bot era CEGO a
 * eles (probe prod 2026-07-10: rep com events=0 e blocked=8 → briefing diria
 * "agenda livre"). Este módulo busca e NORMALIZA os bloqueios pro briefing
 * matinal e pro `list_appointments`.
 *
 * Design (estudo _planning/ghl-blocked-slots/):
 * - Read-only + fail-soft: falha aqui NUNCA derruba a seção principal.
 * - Dedup DEFENSIVO contra appointments (cobre two-way sync onde o mesmo
 *   compromisso pode vir nos dois endpoints): por id e por sobreposição
 *   (start,end) — appointment tem prioridade (traz contato/status).
 * - Custo de tokens (pós-H44): só title+horário saem pro LLM; notes/address
 *   (invites Zoom com passcode) NUNCA entram no contexto.
 * - Kill-switch: BLOCKED_SLOTS_CONTEXT_ENABLED=0 desliga (default LIGADO —
 *   feature read-only, endpoint provado em prod antes do wire).
 */
import type { GHLClient } from "@/lib/ghl/client";
import { listBlockedSlots } from "@/lib/ghl/operations";

/** Default ON (read-only, fail-soft); `BLOCKED_SLOTS_CONTEXT_ENABLED=0` desliga. */
export function isBlockedSlotsEnabled(): boolean {
  const v = (process.env.BLOCKED_SLOTS_CONTEXT_ENABLED || "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

export interface CalendarBlock {
  id: string;
  /** Título real do evento (Google manda o texto; vazio/privado → "(ocupado)"). */
  title: string;
  start_iso: string;
  end_iso: string;
  /** "google_calendar" = evento do Google; "native" = bloqueio criado no Spark Leads. */
  source: "google_calendar" | "native";
  master_event_id?: string;
}

/**
 * Busca os bloqueios do USER na janela e normaliza. Fail-soft: erro → [].
 * `existingAppointments` (opcional) alimenta o dedup defensivo.
 */
export async function fetchCalendarBlocks(
  ghl: GHLClient,
  params: {
    locationId: string;
    userId: string;
    startMs: number;
    endMs: number;
    existingAppointments?: Array<{ id?: string; startTime?: string; endTime?: string }>;
  },
): Promise<CalendarBlock[]> {
  if (!isBlockedSlotsEnabled()) return [];
  try {
    const res = await listBlockedSlots(ghl, {
      locationId: params.locationId,
      userId: params.userId,
      startTime: String(params.startMs),
      endTime: String(params.endMs),
    });
    const events = res.events || [];

    // Índices de dedup contra appointments já conhecidos (two-way sync).
    const apptIds = new Set(
      (params.existingAppointments || []).map((a) => a.id).filter(Boolean) as string[],
    );
    const apptWindows = new Set(
      (params.existingAppointments || [])
        .map((a) => windowKey(a.startTime, a.endTime))
        .filter(Boolean) as string[],
    );

    const out: CalendarBlock[] = [];
    const seen = new Set<string>();
    for (const ev of events) {
      if (!ev?.id || ev.deleted === true) continue;
      if (seen.has(ev.id) || apptIds.has(ev.id)) continue;
      // Mesmo horário exato de um appointment = mesmo compromisso espelhado.
      const wk = windowKey(ev.startTime, ev.endTime);
      if (wk && apptWindows.has(wk)) continue;
      seen.add(ev.id);
      out.push({
        id: ev.id,
        title: (ev.title || "").trim() || "(ocupado)",
        start_iso: ev.startTime,
        end_iso: ev.endTime,
        source: ev.createdBy?.source === "google_calendar" ? "google_calendar" : "native",
        master_event_id: ev.masterEventId,
      });
    }
    out.sort((a, b) => a.start_iso.localeCompare(b.start_iso));
    return out;
  } catch (err) {
    console.warn(
      "[calendar-context] blocked-slots fetch falhou (fail-soft, segue sem blocks):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

function windowKey(start?: string, end?: string): string | null {
  if (!start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return `${s}|${e}`;
}
