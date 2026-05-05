/**
 * Tools de Calendário e Appointments.
 *
 * GOTCHAS:
 * - free-slots usa startDate/endDate em milissegundos (string)
 * - calendars/events usa startTime/endTime em milissegundos
 * - appointments crud em /calendars/events/appointments (não em /contacts/{id})
 */

import type { ToolEntry } from "./types";
import { validateGhlId, validateIso8601, getRepGhlUserId, ghlErrorToResult } from "./types";

const listAppointments: ToolEntry = {
  def: {
    name: "list_appointments",
    description: "Lista appointments do rep (default só os dele) numa janela de tempo.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        when: {
          type: "string",
          enum: ["today", "tomorrow", "week", "next_week"],
          description: "Janela de tempo. Default 'today'.",
        },
        all_users: {
          type: "boolean",
          description: "Se true, lista de TODA a location (não só do rep). Default false.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const when = String(args.when || "today");
    const allUsers = args.all_users === true;
    const now = new Date();
    let startTs: number, endTs: number;
    if (when === "today") {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      startTs = s.getTime(); endTs = e.getTime();
    } else if (when === "tomorrow") {
      const s = new Date(now); s.setDate(s.getDate() + 1); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setHours(23, 59, 59, 999);
      startTs = s.getTime(); endTs = e.getTime();
    } else if (when === "next_week") {
      const s = new Date(now); s.setDate(s.getDate() + 7); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setDate(e.getDate() + 7); e.setHours(23, 59, 59, 999);
      startTs = s.getTime(); endTs = e.getTime();
    } else {
      startTs = now.getTime();
      const e = new Date(now); e.setDate(e.getDate() + 7);
      endTs = e.getTime();
    }
    const repUserId = getRepGhlUserId(ctx);

    try {
      const res = await ctx.ghlClient.get<{
        events?: Array<{
          id: string; title?: string; startTime: string; endTime: string;
          contactId?: string; appointmentStatus?: string; assignedUserId?: string; calendarId?: string;
        }>;
      }>("/calendars/events", {
        locationId: ctx.locationId,
        startTime: String(startTs),
        endTime: String(endTs),
        ...(allUsers || !repUserId ? {} : { userId: repUserId }),
      });
      const events = res.events || [];
      // Fix Track 3 HIGH-8 (review 2026-05-05): retorna not_found pra empty
      // em vez de status:ok+data:[] (semântica clara pro LLM).
      if (events.length === 0) {
        return {
          status: "not_found",
          message: `Nenhum appointment ${when === "today" ? "hoje" : `em '${when}'`} pra ${allUsers ? "esta location" : "você"}.`,
        };
      }
      return {
        status: "ok",
        data: events.map((e) => ({
          id: e.id, title: e.title || "(sem título)",
          start: e.startTime, end: e.endTime,
          contact_id: e.contactId || null,
          status: e.appointmentStatus || "scheduled",
          assigned_to: e.assignedUserId,
          calendar_id: e.calendarId,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de appointments");
    }
  },
};

const listCalendars: ToolEntry = {
  def: {
    name: "list_calendars",
    description: "Lista calendários disponíveis na location ativa.",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    try {
      const res = await ctx.ghlClient.get<{
        calendars?: Array<{ id: string; name?: string; description?: string; widgetSlug?: string }>;
      }>("/calendars/", { locationId: ctx.locationId });
      return {
        status: "ok",
        data: (res.calendars || []).map((c) => ({
          id: c.id, name: c.name, description: c.description, slug: c.widgetSlug,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de calendários");
    }
  },
};

const getFreeSlots: ToolEntry = {
  def: {
    name: "get_free_slots",
    description:
      "Lista horários disponíveis NUM CALENDÁRIO ESPECÍFICO. Calendar-centric: confia nas regras do calendar pra agregar (business hours, conflicts internos, Google Calendar synced). Use ANTES de `create_appointment` pra validar slot.\n\n⚠️ Use SOMENTE quando rep menciona um calendar específico ('horários no Calendar X', 'quando posso marcar no Field Training'). Pra 'EU livre em geral?' use `list_my_free_slots` (cross-calendar logic).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "ID do calendário (use list_calendars antes)." },
        start_date: { type: "string", description: "ISO 8601 do início da janela." },
        end_date: { type: "string", description: "ISO 8601 do fim da janela (max 7 dias depois)." },
        timezone: { type: "string", description: "Opcional, ex: 'America/New_York'." },
      },
      required: ["calendar_id", "start_date", "end_date"],
    },
  },
  handler: async (ctx, args) => {
    const calendarId = String(args.calendar_id || "");
    const invalid = validateGhlId(calendarId, "calendar");
    if (invalid) return invalid;
    const startDateInvalid = validateIso8601(String(args.start_date || ""), "start_date");
    if (startDateInvalid) return startDateInvalid;
    const endDateInvalid = validateIso8601(String(args.end_date || ""), "end_date");
    if (endDateInvalid) return endDateInvalid;
    const startMs = new Date(String(args.start_date)).getTime();
    const endMs = new Date(String(args.end_date)).getTime();

    if (endMs <= startMs) {
      return {
        status: "error",
        message: "end_date deve ser DEPOIS de start_date.",
        retryable: false,
      };
    }
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    if (endMs - startMs > SEVEN_DAYS_MS) {
      return {
        status: "error",
        message: "Janela máxima é 7 dias. Use uma window menor e chame de novo se precisar mais.",
        retryable: false,
      };
    }

    const repUserId = getRepGhlUserId(ctx);

    try {
      // Calendar-centric puro (review 2026-05-05): SEM cross-calendar logic.
      // Confia no GHL pra agregar regras desse calendar específico (business
      // hours, Google Calendar synced, conflicts internos).
      // Pra "rep livre cross-calendar" use list_my_free_slots (separate tool).
      const res = await ctx.ghlClient.get<Record<string, { slots?: string[] }>>(
        `/calendars/${calendarId}/free-slots`,
        {
          startDate: String(startMs),
          endDate: String(endMs),
          ...(args.timezone ? { timezone: String(args.timezone) } : {}),
          // userId pra round-robin filtrar slots pro user específico (B2 fix)
          ...(repUserId ? { userId: repUserId } : {}),
        },
      );
      const slotsByDate: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(res)) {
        if (key === "traceId" || !value) continue;
        const slots = Array.isArray(value) ? (value as unknown as string[]) : value.slots || [];
        if (slots.length > 0) slotsByDate[key] = slots;
      }

      return {
        status: "ok",
        data: {
          slots_by_date: slotsByDate,
          calendar_id: calendarId,
          source: "calendar-centric — /calendars/{id}/free-slots respeita business hours + Google sync interno daquele calendar.",
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de horários disponíveis");
    }
  },
};

/**
 * Calcula start/end do dia/semana NO TIMEZONE do rep.
 * Antes usava setHours() que opera em UTC (timezone do servidor Vercel).
 * Pra rep em EDT (UTC-4), "today" via UTC perdia 4h de cada lado.
 * Agora usa Intl.DateTimeFormat pra obter boundaries certos.
 */
function computeWindowInTz(
  when: string,
  timezone: string,
): { startMs: number; endMs: number } {
  // Pega "today" no timezone do rep
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const todayStr = fmt.format(new Date()); // "2026-05-05"

  // Helper pra construir start-of-day no timezone do rep
  const startOfDayInTz = (dateStr: string): number => {
    // Trick: pega midnight UTC do dia e ajusta pelo offset do rep tz nesse dia
    const utcMidnight = new Date(`${dateStr}T00:00:00Z`).getTime();
    // Calcula offset do rep tz pra esse dia
    const sample = new Date(utcMidnight);
    const tzFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const parts = tzFmt.formatToParts(sample);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
    const h = parseInt(get("hour"));
    const m = parseInt(get("minute"));
    // utcMidnight em UTC = midnight UTC. No tz é (h:m). Pra ter midnight no tz,
    // recua o offset entre o que tz vê (h:m) e UTC midnight (00:00).
    const offsetMin = h * 60 + m;
    return utcMidnight - offsetMin * 60_000;
  };

  const addDays = (dateStr: string, days: number): string => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  let startStr: string, endStr: string;
  if (when === "today") {
    startStr = todayStr;
    endStr = addDays(todayStr, 1);
  } else if (when === "tomorrow") {
    startStr = addDays(todayStr, 1);
    endStr = addDays(todayStr, 2);
  } else if (when === "next_week") {
    startStr = addDays(todayStr, 7);
    endStr = addDays(todayStr, 14);
  } else {
    // 'week'
    startStr = todayStr;
    endStr = addDays(todayStr, 7);
  }

  const startMs = startOfDayInTz(startStr);
  const endMs = startOfDayInTz(endStr) - 1; // último ms do dia anterior
  return { startMs, endMs };
}

const listMyFreeSlots: ToolEntry = {
  def: {
    name: "list_my_free_slots",
    description:
      "Lista horários LIVRES do REP num período (USER-CENTRIC). Considera todos os calendars do rep + appointments cross-calendar (qualquer calendar onde rep é assignedUser) + blocks manuais + Google Calendar synced internally por calendar.\n\nUse SEMPRE quando rep pergunta 'que horários EU tenho livres', 'qual minha disponibilidade', 'tô livre quando', 'meu horário hoje/amanhã'.\n\n⚠️ NUNCA use:\n- `list_appointments` + reasoning manual pra calcular livre — perde Google Calendar blocks\n- `get_free_slots` pra essa pergunta — get_free_slots é calendar-centric (sem cross-calendar logic), ideal pra 'horários no Calendar X' mas NÃO pra 'EU livre'\n\nEsta tool é a ÚNICA correta pra user-centric availability.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        when: {
          type: "string",
          enum: ["today", "tomorrow", "week", "next_week"],
          description: "Janela. Default 'today'.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const when = String(args.when || "today");
    const repUserId = getRepGhlUserId(ctx);
    if (!repUserId) {
      return {
        status: "error",
        message: "Não consegui resolver seu user_id. Tente confirm_rep_timezone primeiro ou avise admin.",
        retryable: false,
      };
    }

    // B3 + I6 fix (review 2026-05-05): timezone window correto.
    // Antes setHours operava em UTC do servidor Vercel — pra rep em EDT,
    // window cobria parte do dia errado (perdia late-night EDT, incluía
    // night anterior). Agora calcula boundaries no timezone do rep.
    const repTimezone = ctx.rep.timezone || "America/New_York";
    const { startMs, endMs } = computeWindowInTz(when, repTimezone);

    try {
      // Lista TODOS os calendars da location — necessário pra cross-calendar
      // event coverage (I5 fix): appt do rep pode estar em calendar onde ele
      // não é team_member (criado por colega).
      const calRes = await ctx.ghlClient.get<{
        calendars?: Array<{
          id: string;
          name?: string;
          slotDuration?: number;
          slotDurationUnit?: string;
          openHours?: Array<{
            daysOfTheWeek: number[];
            hours: Array<{ openHour: number; openMinute: number; closeHour: number; closeMinute: number }>;
          }>;
          teamMembers?: Array<{ userId: string; selected?: boolean }>;
        }>;
      }>("/calendars/", { locationId: ctx.locationId });

      const allCalendars = calRes.calendars || [];

      // userCalendars = onde rep é team_member ATIVO (fonte de /free-slots)
      const userCalendars = allCalendars.filter((c) =>
        (c.teamMembers || []).some(
          (tm) => tm.userId === repUserId && tm.selected !== false,
        ),
      );

      if (userCalendars.length === 0) {
        return {
          status: "not_found",
          message: "Você não é team_member de nenhum calendar ativo nesta location.",
        };
      }

      // eventCalendars = TODOS os calendars (cap 30 pra latência)
      const eventCalendars = allCalendars.slice(0, 30);
      const truncatedCalendars = allCalendars.length > 30;

      let eventsFailed = 0;
      const [freeSlotsResults, eventsResults] = await Promise.all([
        Promise.all(
          userCalendars.map((c) =>
            ctx.ghlClient
              .get<Record<string, { slots?: string[] }>>(
                `/calendars/${c.id}/free-slots`,
                {
                  startDate: String(startMs),
                  endDate: String(endMs),
                  userId: repUserId,
                },
              )
              .then((res) => ({ calendar: c, raw: res, ok: true }))
              .catch(() => ({
                calendar: c,
                raw: {} as Record<string, { slots?: string[] }>,
                ok: false,
              })),
          ),
        ),
        Promise.all(
          eventCalendars.map((c) =>
            ctx.ghlClient
              .get<{
                events?: Array<{
                  startTime: string;
                  endTime: string;
                  appointmentStatus?: string;
                  assignedUserId?: string;
                  title?: string;
                }>;
              }>("/calendars/events", {
                locationId: ctx.locationId,
                calendarId: c.id,
                startTime: String(startMs),
                endTime: String(endMs),
              })
              .then((res) => ({ calendar: c, events: res.events || [] }))
              .catch(() => {
                eventsFailed++;
                return { calendar: c, events: [] };
              }),
          ),
        ),
      ]);

      // 1. UNION dos free slots — track per-slot duration + sources
      type SlotMeta = { duration_min: number; sources: Set<string> };
      const unionByDate: Record<string, Map<string, SlotMeta>> = {};
      const validCalendarNames: string[] = [];
      const userCalendarsResponded = new Set<string>();
      for (const r of freeSlotsResults) {
        if (!r.ok) continue;
        userCalendarsResponded.add(r.calendar.id);
        validCalendarNames.push(r.calendar.name || r.calendar.id);
        const durRaw = r.calendar.slotDuration || 30;
        const durMin = r.calendar.slotDurationUnit === "hours" ? durRaw * 60 : durRaw;
        for (const [key, value] of Object.entries(r.raw)) {
          if (key === "traceId" || !value) continue;
          const slots = Array.isArray(value) ? (value as unknown as string[]) : value.slots || [];
          if (slots.length === 0) continue;
          if (!unionByDate[key]) unionByDate[key] = new Map();
          for (const s of slots) {
            const existing = unionByDate[key].get(s);
            if (existing) {
              existing.sources.add(r.calendar.id);
              existing.duration_min = Math.max(existing.duration_min, durMin);
            } else {
              unionByDate[key].set(s, {
                duration_min: durMin,
                sources: new Set([r.calendar.id]),
              });
            }
          }
        }
      }

      // 2. Coleta events onde rep é assignedUser (cross-calendar coverage)
      const conflicts: Array<{ start: number; end: number; title?: string }> = [];
      for (const r of eventsResults) {
        for (const event of r.events) {
          if (event.assignedUserId !== repUserId) continue;
          const status = (event.appointmentStatus || "scheduled").toLowerCase();
          if (
            status === "cancelled" || status === "noshow" ||
            status === "no-show" || status === "invalid"
          ) continue;
          const eStart = new Date(event.startTime).getTime();
          const eEnd = new Date(event.endTime).getTime();
          if (isNaN(eStart) || isNaN(eEnd)) continue;
          conflicts.push({ start: eStart, end: eEnd, title: event.title });
        }
      }

      // INTERSECT-conservador (B4/I2 best-effort): se slot tá em business
      // hours de N calendars do rep mas só K < N retornaram, K-N escondeu
      // — provável Google Calendar block escapando.
      function calendarHasOpenHoursAt(
        cal: typeof userCalendars[0],
        slotMs: number,
      ): boolean {
        if (!cal.openHours || cal.openHours.length === 0) return true;
        const d = new Date(slotMs);
        const wd = d.getUTCDay();
        const hh = d.getUTCHours();
        const mm = d.getUTCMinutes();
        const slotMinOfDay = hh * 60 + mm;
        for (const block of cal.openHours) {
          if (!block.daysOfTheWeek.includes(wd)) continue;
          for (const range of block.hours) {
            const openMin = range.openHour * 60 + range.openMinute;
            const closeMin = range.closeHour * 60 + range.closeMinute;
            if (slotMinOfDay >= openMin && slotMinOfDay < closeMin) return true;
          }
        }
        return false;
      }

      const filteredByDate: Record<string, string[]> = {};
      let removedConflict = 0;
      let removedSuspectBlock = 0;
      const suspectBlockExamples: string[] = [];
      for (const [date, slotsMap] of Object.entries(unionByDate)) {
        const sorted = Array.from(slotsMap.entries()).sort(([a], [b]) =>
          a.localeCompare(b),
        );
        const ok: string[] = [];
        for (const [slotIso, meta] of sorted) {
          const slotStart = new Date(slotIso).getTime();
          const slotEnd = slotStart + meta.duration_min * 60_000;

          const hasConflict = conflicts.some(
            (c) => slotStart < c.end && slotEnd > c.start,
          );
          if (hasConflict) {
            removedConflict++;
            continue;
          }

          // INTERSECT-conservador SOMENTE se 2+ userCalendars
          if (userCalendars.length >= 2) {
            const calsWithBH = userCalendars.filter(
              (c) =>
                userCalendarsResponded.has(c.id) &&
                calendarHasOpenHoursAt(c, slotStart),
            );
            const calsReturning = meta.sources.size;
            if (
              calsWithBH.length >= 2 &&
              calsReturning < calsWithBH.length
            ) {
              const missing = calsWithBH
                .filter((c) => !meta.sources.has(c.id))
                .map((c) => c.name || c.id);
              removedSuspectBlock++;
              if (suspectBlockExamples.length < 3) {
                suspectBlockExamples.push(
                  `${slotIso} (esperado em ${calsWithBH.length}, retornou em ${calsReturning}; missing: ${missing.slice(0, 2).join(", ")})`,
                );
              }
              continue;
            }
          }

          ok.push(slotIso);
        }
        if (ok.length > 0) filteredByDate[date] = ok;
      }

      const totalSlots = Object.values(filteredByDate).reduce(
        (s, arr) => s + arr.length,
        0,
      );

      return {
        status: "ok",
        data: {
          slots_by_date: filteredByDate,
          total_slots: totalSlots,
          calendars_checked: validCalendarNames.length,
          calendar_names: validCalendarNames,
          conflicts_found: conflicts.length,
          slots_removed_conflicts: removedConflict,
          slots_removed_suspect_block: removedSuspectBlock,
          suspect_block_examples: suspectBlockExamples,
          partial: eventsFailed > 0 || truncatedCalendars,
          partial_calendars_failed: eventsFailed,
          truncated_calendars: truncatedCalendars,
          window: {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            timezone: repTimezone,
          },
          source:
            "USER-CENTRIC: UNION /free-slots dos rep's calendars (com userId p/ round-robin) MENOS events cross-calendar onde assignedUserId=rep. INTERSECT-conservador remove slots suspeitos de Google block (slot ausente de calendar com business hours coverage).",
          warning_google_calendar:
            "Best-effort detection de Google Calendar blocks via INTERSECT. Pode escapar se rep tem agenda Google pessoal NÃO integrada — confirma no GHL UI antes de marcar.",
          warning_partial:
            eventsFailed > 0
              ? `${eventsFailed} calendars falharam ao retornar events — alguns conflicts podem ter sido perdidos.`
              : null,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de horários livres");
    }
  },
};

const getAppointment: ToolEntry = {
  def: {
    name: "get_appointment",
    description:
      "Detalhes completos de um appointment pelo id. Use quando uma alert/regra menciona appointment_id e você precisa saber horário, contact, status, calendar, etc.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { appointment_id: { type: "string" } },
      required: ["appointment_id"],
    },
  },
  handler: async (ctx, args) => {
    const appointmentId = String(args.appointment_id || "");
    const invalid = validateGhlId(appointmentId, "appointment");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        appointment?: {
          id: string; title?: string; startTime?: string; endTime?: string;
          contactId?: string; appointmentStatus?: string;
          assignedUserId?: string; calendarId?: string;
          address?: string; meetingLocationType?: string;
          notes?: string; createdAt?: string; updatedAt?: string;
        };
      }>(`/calendars/events/appointments/${appointmentId}`);
      if (!res.appointment) return { status: "not_found", message: "Appointment não encontrado" };
      const a = res.appointment;
      return {
        status: "ok",
        data: {
          id: a.id,
          title: a.title || null,
          start: a.startTime || null,
          end: a.endTime || null,
          contact_id: a.contactId || null,
          status: a.appointmentStatus || "scheduled",
          assigned_to: a.assignedUserId || null,
          calendar_id: a.calendarId || null,
          address: a.address || null,
          meeting_location_type: a.meetingLocationType || null,
          notes: a.notes || null,
          created_at: a.createdAt || null,
          updated_at: a.updatedAt || null,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de appointment");
    }
  },
};

const createAppointment: ToolEntry = {
  def: {
    name: "create_appointment",
    description:
      "⚠️ AGENDA reunião pra um contato no calendário. AFETA o lead — sempre confirma com o rep ANTES. Use get_free_slots pra escolher horário válido.\n\nObservação importante: pra calendars **round-robin/collective/group** (com vários team members), NÃO passe `assigned_user_id` — deixe o Spark Leads escolher automaticamente. Pra calendars **personal/service** (1 user só), opcional. Default: não passar (mais seguro pra qualquer tipo de calendar).",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        contact_id: { type: "string" },
        start_time: { type: "string", description: "ISO 8601" },
        end_time: { type: "string", description: "ISO 8601" },
        title: { type: "string" },
        meeting_location_type: { type: "string", description: "Ex: 'custom', 'phone', 'zoom'." },
        meeting_location: { type: "string", description: "Ex: link Zoom, telefone, endereço." },
        assigned_user_id: {
          type: "string",
          description:
            "OPCIONAL. ID do user a quem atribuir a reunião. Use APENAS se o rep pedir explicitamente OU se for um calendar personal de 1 user específico. Pra round-robin/collective/group, OMITA — Spark Leads escolhe automaticamente baseado em disponibilidade.",
        },
      },
      required: ["calendar_id", "contact_id", "start_time", "end_time"],
    },
  },
  handler: async (ctx, args) => {
    const calendarId = String(args.calendar_id || "");
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(calendarId, "calendar") || validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const startInvalid = validateIso8601(String(args.start_time || ""), "start_time");
    if (startInvalid) return startInvalid;
    const endInvalid = validateIso8601(String(args.end_time || ""), "end_time");
    if (endInvalid) return endInvalid;

    // Fix bug observado em prod 2026-05-04: antes setávamos
    // `body.assignedUserId = repUser` SEMPRE. Isso quebrava calendars
    // round-robin com `lookBusyConfig` ativado — GHL valida slot
    // especificamente pro user e o look-busy esconde 50% dos slots,
    // retornando "slot no longer available" pra horários que get_free_slots
    // listou como livres. Solução: NÃO passar assignedUserId por default;
    // deixar GHL decidir baseado no calendar type. LLM pode forçar via
    // arg `assigned_user_id` se precisar (caso edge: calendar personal).
    try {
      const body: Record<string, unknown> = {
        calendarId,
        contactId,
        locationId: ctx.locationId,
        startTime: new Date(String(args.start_time)).toISOString(),
        endTime: new Date(String(args.end_time)).toISOString(),
        ...(args.title ? { title: String(args.title) } : {}),
        ...(args.meeting_location_type ? { meetingLocationType: String(args.meeting_location_type) } : {}),
        ...(args.meeting_location ? { address: String(args.meeting_location) } : {}),
        ...(args.assigned_user_id
          ? { assignedUserId: String(args.assigned_user_id) }
          : {}),
      };

      const res = await ctx.ghlClient.post<{
        id?: string;
        appointment?: { id: string };
        assignedUserId?: string;
      }>("/calendars/events/appointments", body);
      const apptId = res.id || res.appointment?.id;
      return {
        status: "ok",
        data: {
          appointment_id: apptId,
          assigned_to: res.assignedUserId || null,
        },
      };
    } catch (err) {
      // Pedro 2026-05-04: se rep passou assigned_user_id explícito E o erro
      // foi "slot not available", enriquece com lista de OUTROS team_members
      // do calendar pro LLM oferecer alternativa ("seu user tá bloqueado,
      // quer tentar com X ou Y?").
      const errMsg = err instanceof Error ? err.message : String(err);
      const isSlotBlock = /slot.*not.*available|no longer available/i.test(errMsg);
      if (args.assigned_user_id && isSlotBlock) {
        try {
          const calRes = await ctx.ghlClient.get<{
            calendar?: {
              teamMembers?: Array<{ userId?: string; isPrimary?: boolean }>;
            };
          }>(`/calendars/${calendarId}`);
          const others = (calRes.calendar?.teamMembers || [])
            .map((tm) => tm.userId)
            .filter((id): id is string => !!id && id !== String(args.assigned_user_id));
          if (others.length > 0) {
            const repUser = getRepGhlUserId(ctx);
            return {
              status: "error",
              message:
                `O horário tá bloqueado pro user ${args.assigned_user_id}` +
                (args.assigned_user_id === repUser ? " (você)" : "") +
                ` — pode ser look-busy do calendar OU conflito real. ` +
                `Outros team_members do mesmo calendar: ${others.join(", ")}. ` +
                `Pergunte ao rep se quer tentar com algum deles, OU se prefere outro horário (use get_free_slots).`,
              retryable: false,
            };
          }
        } catch {
          // Falha no calendar lookup — cai pro fallback genérico abaixo
        }
      }
      return ghlErrorToResult(err, "criação de appointment");
    }
  },
};

// =====================================================================
// Tool: block_calendar_slot — bloqueia agenda PESSOAL do rep
// =====================================================================
const blockCalendarSlot: ToolEntry = {
  def: {
    name: "block_calendar_slot",
    description:
      "⚠️ BLOQUEIA um horário no calendar do PRÓPRIO REP pra compromisso pessoal/folga/lembrete. NÃO é appointment com cliente:\n- Não envia link de Zoom\n- Não notifica nenhum contato\n- Não conta como reunião nas métricas\n- Só aparece como horário ocupado no calendar do rep, impedindo que clientes book esse slot\n\nUse APENAS quando rep pedir EXPLICITAMENTE pra bloquear agenda — frases como 'bloqueia minha agenda quarta 14h', 'tô em compromisso pessoal sexta 10-12h', 'marca 30min de almoço', 'reserva esse horário pra mim'. NUNCA use como fallback de create_appointment quando o slot tá ocupado — se appointment falhou, ofereça outro horário ou outro user, NÃO bloqueie.\n\nPor padrão bloqueia no user do próprio rep (não em calendar específico). Pra bloquear pra outro membro da equipe, passe assigned_user_id.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        start_time: { type: "string", description: "ISO 8601" },
        end_time: { type: "string", description: "ISO 8601" },
        title: {
          type: "string",
          description:
            "Título do bloqueio (ex: 'Compromisso pessoal', 'Almoço', 'Folga'). Default: 'Bloqueio de agenda'.",
        },
        assigned_user_id: {
          type: "string",
          description:
            "OPCIONAL. ID do user pra quem bloquear. Default: o próprio rep que está conversando.",
        },
      },
      required: ["start_time", "end_time"],
    },
  },
  handler: async (ctx, args) => {
    const startInvalid = validateIso8601(String(args.start_time || ""), "start_time");
    if (startInvalid) return startInvalid;
    const endInvalid = validateIso8601(String(args.end_time || ""), "end_time");
    if (endInvalid) return endInvalid;

    const targetUser = args.assigned_user_id
      ? String(args.assigned_user_id)
      : getRepGhlUserId(ctx);
    if (!targetUser) {
      return {
        status: "error",
        message:
          "Não consegui resolver qual user atribuir o bloqueio. Passe assigned_user_id explicitamente.",
        retryable: false,
      };
    }

    try {
      // Fix CRITICAL Track 4 CRIT-3 (review 2026-05-05): spec do Spark Leads
      // diz "Either calendarId or assignedUserId, NOT both" pra block-slots,
      // E `notes` NÃO existe no spec. Antes, body tinha calendarId+assignedUserId
      // simultâneos + notes inválido → API rejeitava ou ignorava silenciosamente.
      // Use case real é "bloqueio pessoal pro rep X" → SÓ assignedUserId.
      const body: Record<string, unknown> = {
        locationId: ctx.locationId,
        assignedUserId: targetUser,
        startTime: new Date(String(args.start_time)).toISOString(),
        endTime: new Date(String(args.end_time)).toISOString(),
        title: args.title ? String(args.title) : "Bloqueio de agenda",
      };
      const res = await ctx.ghlClient.post<{
        id?: string;
        event?: { id: string };
      }>("/calendars/events/block-slots", body);
      const eventId = res.id || res.event?.id;
      return {
        status: "ok",
        data: {
          block_id: eventId,
          assigned_to: targetUser,
          message:
            "Horário bloqueado no calendar (não é appointment com cliente — ninguém é notificado).",
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "bloqueio de agenda");
    }
  },
};

const updateAppointment: ToolEntry = {
  def: {
    name: "update_appointment",
    description: "⚠️ Reagendar um appointment existente (mudar horário ou status). Confirma antes.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        start_time: { type: "string", description: "ISO 8601 novo horário." },
        end_time: { type: "string", description: "ISO 8601 novo fim." },
        appointment_status: {
          type: "string",
          enum: ["confirmed", "showed", "noshow", "cancelled", "invalid"],
          description: "Status do appointment. Use APENAS valores enumerados.",
        },
      },
      required: ["appointment_id"],
    },
  },
  handler: async (ctx, args) => {
    const appointmentId = String(args.appointment_id || "");
    const invalid = validateGhlId(appointmentId, "appointment");
    if (invalid) return invalid;

    const body: Record<string, unknown> = {};
    if (args.start_time) {
      const startInvalid = validateIso8601(String(args.start_time), "start_time");
      if (startInvalid) return startInvalid;
      body.startTime = new Date(String(args.start_time)).toISOString();
    }
    if (args.end_time) {
      const endInvalid = validateIso8601(String(args.end_time), "end_time");
      if (endInvalid) return endInvalid;
      body.endTime = new Date(String(args.end_time)).toISOString();
    }
    if (args.appointment_status) {
      // Fix Track 4 HIGH-3: enforcement em código além do schema enum.
      const VALID_APPT_STATUS = ["confirmed", "showed", "noshow", "cancelled", "invalid"];
      const status = String(args.appointment_status);
      if (!VALID_APPT_STATUS.includes(status)) {
        return {
          status: "error",
          message: `appointment_status inválido. Use ${VALID_APPT_STATUS.join("|")}.`,
          retryable: false,
        };
      }
      body.appointmentStatus = status;
    }
    if (Object.keys(body).length === 0) {
      return { status: "error", message: "Nenhum campo pra atualizar", retryable: false };
    }

    try {
      await ctx.ghlClient.put(`/calendars/events/appointments/${appointmentId}`, body);
      return { status: "ok", data: { appointment_id: appointmentId, updated: Object.keys(body) } };
    } catch (err) {
      return ghlErrorToResult(err, "atualização de appointment");
    }
  },
};

const deleteAppointment: ToolEntry = {
  def: {
    name: "delete_appointment",
    description: "⚠️ AÇÃO IRREVERSÍVEL: Cancela um appointment. Sempre confirma antes.",
    risk: "high",
    parameters: {
      type: "object",
      properties: { appointment_id: { type: "string" } },
      required: ["appointment_id"],
    },
  },
  handler: async (ctx, args) => {
    const appointmentId = String(args.appointment_id || "");
    const invalid = validateGhlId(appointmentId, "appointment");
    if (invalid) return invalid;

    try {
      await ctx.ghlClient.delete(`/calendars/events/appointments/${appointmentId}`);
      return { status: "ok", data: { deleted: appointmentId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de appointment");
    }
  },
};

export const CALENDAR_TOOLS: ToolEntry[] = [
  listAppointments,
  listCalendars,
  getFreeSlots,
  listMyFreeSlots,
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  blockCalendarSlot,
];
