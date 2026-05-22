/**
 * Tools de Calendário e Appointments.
 *
 * GOTCHAS:
 * - free-slots usa startDate/endDate em milissegundos (string)
 * - calendars/events usa startTime/endTime em milissegundos
 * - appointments crud em /calendars/events/appointments (não em /contacts/{id})
 */

import type { ToolContext, ToolEntry } from "./types";
import { validateGhlId, validateIso8601, getRepGhlUserId, ghlErrorToResult, resolveAssignedUserId } from "./types";
import {
  listCalendars as ghlListCalendars,
  getCalendarFreeSlots,
  listCalendarEvents,
  getAppointment as ghlGetAppointment,
  createAppointment as ghlCreateAppointment,
  createBlockSlot,
  updateAppointment as ghlUpdateAppointment,
  deleteAppointment as ghlDeleteAppointment,
  getCalendarDetails,
} from "@/lib/ghl/operations";
import type { ToolResult } from "@/types/account-assistant";
import { recordSignalAsync } from "@/lib/admin-signals/recorder";
import { updateRepById } from "@/lib/repositories/rep-identities.repo";

/**
 * Lê a preferência de agendamento salva do rep (calendário/duração padrão).
 * Agendamento V2 (D2). Vazio = rep nunca setou (bot vai aprender no 1º uso).
 */
function getSchedulingPref(ctx: ToolContext): {
  default_calendar_id?: string;
  default_calendar_name?: string;
  default_duration_min?: number;
} {
  return ctx.rep.profile?.preferences?.scheduling || {};
}

/**
 * Resolve qual calendário usar pra agendar SEM perguntar (parte code-side da
 * regra "nome dito > pref salva > único"). O `named` (nome que o rep falou) é
 * resolvido pelo LLM; aqui cobrimos pref salva e calendário único.
 *
 * Retorna:
 *  - resolved_calendar_id + resolution="default_pref" se a pref salva existe e
 *    ainda está na lista
 *  - resolved + resolution="only_calendar" se só há 1 calendário
 *  - resolution="ambiguous" (sem resolved) quando >1 e sem pref → LLM decide
 *  - resolution="none" quando não há nenhum calendário
 */
export function resolveCalendarChoice(
  calendarIds: string[],
  savedDefaultId?: string,
): { resolved_calendar_id?: string; resolution: "default_pref" | "only_calendar" | "ambiguous" | "none" } {
  if (calendarIds.length === 0) return { resolution: "none" };
  if (savedDefaultId && calendarIds.includes(savedDefaultId)) {
    return { resolved_calendar_id: savedDefaultId, resolution: "default_pref" };
  }
  if (calendarIds.length === 1) {
    return { resolved_calendar_id: calendarIds[0], resolution: "only_calendar" };
  }
  return { resolution: "ambiguous" };
}

/**
 * H26 (review 2026-05-14): valida override flags ADMIN-ONLY pra appointments.
 *
 * Restrito a admin/internal team (ctx.rep.is_internal === true, populado por
 * H17 detectIsInternal — env phone, role agency*, ou 5+ ghl_users).
 *
 * Flags cobertas (todas vão em POST/PUT /calendars/events/appointments):
 *  - ignoreFreeSlotValidation: fura slot bloqueado/conflict
 *  - ignoreDateRange: pula min notice / max horizon
 *  - toNotify=false: desativa automation/notification
 *
 * NÃO INCLUI overrideLocationConfig — esse é auto-ativado quando rep
 * especifica meeting_location_type/meeting_location (gate diferente,
 * qualquer rep pode trocar local de reunião).
 *
 * Retorno:
 *  - { ok: false, error } se rep não-admin tentou usar override
 *  - { ok: true, body, used } com campos GHL prontos pra mergear no body
 *  - { ok: true, body: {}, used: [] } se nenhuma flag foi passada
 */
export function buildOverridePayload(
  ctx: ToolContext,
  args: Record<string, unknown>,
):
  | { ok: true; body: Record<string, unknown>; used: string[] }
  | { ok: false; error: ToolResult } {
  // Gate de override. Pedro 2026-05-22 (D1): rep PODE forçar bloqueio / min-notice
  // na PRÓPRIA agenda (assignee self / não-setado / round-robin). Na agenda de
  // OUTRO user, segue admin-only. `to_notify:false` (não notificar o CLIENTE) é
  // mais drástico (client-facing) e segue admin-only SEMPRE.
  const wantsSlotOverride =
    args.ignore_free_slot_validation === true || args.ignore_date_range === true;
  const wantsNoNotify = args.to_notify === false;

  if (wantsNoNotify && !ctx.rep.is_internal) {
    return {
      ok: false,
      error: {
        status: "error",
        message:
          "'Marcar sem notificar o cliente' é restrito a admin. O cliente vai " +
          "receber o convite/lembrete normalmente.",
        retryable: false,
      },
    };
  }
  if (wantsSlotOverride && !ctx.rep.is_internal) {
    const repUserId = getRepGhlUserId(ctx);
    const raw = args.assigned_user_id ? String(args.assigned_user_id).trim() : "";
    const isSelfWord = /^(self|me|eu)$/i.test(raw);
    // Só bloqueia quando o appointment é EXPLICITAMENTE de OUTRO user.
    const explicitOther = raw !== "" && !isSelfWord && raw !== repUserId;
    if (explicitOther) {
      return {
        ok: false,
        error: {
          status: "error",
          message:
            "Forçar horário bloqueado na agenda de OUTRA pessoa é restrito a admin. " +
            "Na sua própria agenda você pode forçar normalmente. Pra esse contato, " +
            "quer que eu veja os horários livres? (use get_free_slots)",
          retryable: false,
        },
      };
    }
    // self / default / round-robin → override permitido na própria agenda.
  }

  const body: Record<string, unknown> = {};
  const used: string[] = [];
  if (args.ignore_free_slot_validation === true) {
    body.ignoreFreeSlotValidation = true;
    used.push("ignore_free_slot_validation");
  }
  if (args.ignore_date_range === true) {
    body.ignoreDateRange = true;
    used.push("ignore_date_range");
  }
  if (args.to_notify === false) {
    body.toNotify = false;
    used.push("to_notify_false");
  }
  return { ok: true, body, used };
}

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
    // Fix LOW-1 (audit 2026-05-05): antes setHours operava em UTC do
    // servidor Vercel — pra rep BR, slot 23h BRT (= 02h UTC dia seguinte)
    // virava "amanhã" pro bot. Agora usa computeWindowInTz igual
    // list_my_free_slots.
    const repTimezoneRaw = ctx.rep.timezone || "America/New_York";
    const { startMs: startTs, endMs: endTs } = computeWindowInTz(
      when,
      repTimezoneRaw,
    );
    const repUserId = getRepGhlUserId(ctx);

    try {
      const res = await listCalendarEvents(ctx.ghlClient, {
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
    description:
      "Lista calendários disponíveis na location ativa. Marca o calendário " +
      "padrão do rep (se ele já salvou um) e sugere qual usar pra agendar " +
      "sem precisar perguntar.",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    try {
      const res = await ghlListCalendars(ctx.ghlClient, ctx.locationId);
      const pref = getSchedulingPref(ctx);
      const calendars = (res.calendars || []).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        slug: c.widgetSlug,
        // Agendamento V2: flag pro LLM saber qual já é o padrão salvo do rep.
        is_default_for_rep: !!pref.default_calendar_id && c.id === pref.default_calendar_id,
      }));

      // Resolução pro LLM agendar sem perguntar (named > pref > único).
      // `named` (nome dito pelo rep) é resolvido pelo próprio LLM; aqui cobrimos
      // pref salva e o caso de calendário único.
      const choice = resolveCalendarChoice(
        calendars.map((c) => c.id).filter((id): id is string => !!id),
        pref.default_calendar_id,
      );

      return {
        status: "ok",
        data: {
          calendars,
          resolved_calendar_id: choice.resolved_calendar_id,
          resolution: choice.resolution,
          default_duration_min: pref.default_duration_min,
        },
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
      const res = await getCalendarFreeSlots(ctx.ghlClient, calendarId, {
        startDate: String(startMs),
        endDate: String(endMs),
        ...(args.timezone ? { timezone: String(args.timezone) } : {}),
        // userId pra round-robin filtrar slots pro user específico (B2 fix)
        ...(repUserId ? { userId: repUserId } : {}),
      });
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
 *
 * Fix HIGH bug 2026-05-05 (validation re-review): tz inválido (ex: rep
 * passa "BRT" em vez de "America/Sao_Paulo") causava RangeError. Agora
 * valida com try/catch e usa fallback "America/New_York" (default da
 * Brazillionaires US-based).
 */
function computeWindowInTz(
  when: string,
  timezone: string,
): { startMs: number; endMs: number; tzUsed: string } {
  // Valida tz — Intl.DateTimeFormat lança RangeError pra tz inválido
  let tzUsed = timezone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tzUsed });
  } catch {
    tzUsed = "America/New_York";
  }

  // Pega "today" no timezone do rep
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tzUsed,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const todayStr = fmt.format(new Date()); // "2026-05-05"

  // Helper pra construir start-of-day no timezone do rep
  // Fix CRITICAL bug 2026-05-05 (descoberto via test direto Marcos):
  // Versão antiga `utcMidnight - h*60min` funcionava só pra timezones com
  // offset positivo (Asia/Europe). Pra negative offsets (Americas), retornava
  // start do dia ANTERIOR. Affected ALL Brazillionaires reps US — toda call
  // de list_my_free_slots('tomorrow') buscava window do TODAY.
  //
  // Algoritmo correto: calcula offset real do tz comparando o que ele vê
  // como UTC vs UTC real, depois subtrai do utcMidnight do dia desejado.
  const startOfDayInTz = (dateStr: string): number => {
    const utcMidnight = new Date(`${dateStr}T00:00:00Z`);
    const utcMs = utcMidnight.getTime();
    const tzFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzUsed,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = tzFmt.formatToParts(utcMidnight);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
    // "What tz sees" representado como se fosse UTC (mesmo wall-clock)
    const tzAsIfUtc = Date.UTC(
      parseInt(get("year"), 10),
      parseInt(get("month"), 10) - 1,
      parseInt(get("day"), 10),
      parseInt(get("hour"), 10) === 24 ? 0 : parseInt(get("hour"), 10),
      parseInt(get("minute"), 10),
      parseInt(get("second"), 10),
    );
    // offsetMs = quanto o tz tá adiantado(+) ou atrasado(-) em relação a UTC
    const offsetMs = tzAsIfUtc - utcMs;
    // Midnight do dia X no tz = utcMidnight do dia X - offsetMs
    // (positivo: tz adiantado, midnight tz vem ANTES de utcMidnight)
    // (negativo: tz atrasado, midnight tz vem DEPOIS de utcMidnight)
    return utcMs - offsetMs;
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
  return { startMs, endMs, tzUsed };
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
    //
    // computeWindowInTz valida tz e retorna `tzUsed` (fallback NY se inválido).
    // Usar tzUsed downstream pra evitar passar tz inválido pra
    // calendarHasOpenHoursAt e pro warning do payload.
    const repTimezoneRaw = ctx.rep.timezone || "America/New_York";
    const { startMs, endMs, tzUsed: repTimezone } = computeWindowInTz(
      when,
      repTimezoneRaw,
    );

    try {
      // Lista TODOS os calendars da location — necessário pra cross-calendar
      // event coverage (I5 fix): appt do rep pode estar em calendar onde ele
      // não é team_member (criado por colega).
      const calRes = await ghlListCalendars(ctx.ghlClient, ctx.locationId);

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

      // Fix CRIT-2 + CRIT-5 (audit 2026-05-05): distingue:
      //  - eventsFailed: erro transient (5xx/network/timeout) — calendar
      //    EXISTE mas falha temporária. Bot deve avisar parcial.
      //  - eventsMissingField: 200 OK mas payload sem campo `events`
      //    (silent corruption do GHL — antes contava como sucesso "0 events"
      //    e bot reportava livre com falsa confiança).
      //  - eventsNotFound (404): calendar não existe (deletado entre
      //    /calendars/ e a chamada). Não conta como "failed" pra warning.
      let eventsFailed = 0;
      let eventsMissingField = 0;
      let eventsNotFound = 0;
      type EventCalendarResult = {
        calendar: typeof eventCalendars[0];
        events: Array<{
          id?: string;
          startTime: string;
          endTime: string;
          appointmentStatus?: string;
          assignedUserId?: string;
          title?: string;
        }>;
        ok: boolean;
      };
      const [freeSlotsResults, eventsResults] = await Promise.all([
        Promise.all(
          userCalendars.map((c) =>
            getCalendarFreeSlots(ctx.ghlClient, c.id, {
              startDate: String(startMs),
              endDate: String(endMs),
              userId: repUserId,
            })
              .then((res) => ({
                calendar: c,
                raw: res as Record<string, { slots?: string[] }>,
                ok: true,
              }))
              .catch(() => ({
                calendar: c,
                raw: {} as Record<string, { slots?: string[] }>,
                ok: false,
              })),
          ),
        ),
        Promise.all<EventCalendarResult>(
          eventCalendars.map((c) =>
            listCalendarEvents(ctx.ghlClient, {
              locationId: ctx.locationId,
              calendarId: c.id,
              startTime: String(startMs),
              endTime: String(endMs),
            })
              .then((res) => {
                if (!Array.isArray(res?.events)) {
                  // 200 OK mas payload sem events array — silent GHL corruption
                  eventsMissingField++;
                  return { calendar: c, events: [], ok: false };
                }
                return { calendar: c, events: res.events, ok: true };
              })
              .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (/GHL API 404|not.found/i.test(msg)) {
                  // Calendar deletado — não conta como falha de availability
                  eventsNotFound++;
                } else {
                  eventsFailed++;
                }
                return { calendar: c, events: [], ok: false };
              }),
          ),
        ),
      ]);

      // 1. UNION dos free slots — track per-source duration + sources
      // Fix HIGH-4 (audit 2026-05-05): antes usava `Math.max` da duration
      // pra conflict check — calendar A 30min retornando 14h ficava bloqueado
      // por conflict 14:30 (porque calendar B retornava 60min e conflitava).
      // Agora track duration POR SOURCE; conflict só remove slot se TODAS as
      // sources conflitarem (mais permissivo, evita esconder livre legítimo).
      // Fix LOW-3: slot format defensivo — string corrupta vira [].
      // Fix LOW-4: validate date-shape antes de tratar key como slots map.
      // Fix MED-2: slotDuration validation (rejeita 0/null/negative).
      type SlotMeta = { sources: Map<string, number> }; // calId → durationMin
      const unionByDate: Record<string, Map<string, SlotMeta>> = {};
      const validCalendarNames: string[] = [];
      const userCalendarsResponded = new Set<string>();
      const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
      for (const r of freeSlotsResults) {
        if (!r.ok) continue;
        userCalendarsResponded.add(r.calendar.id);
        validCalendarNames.push(r.calendar.name || r.calendar.id);
        const rawDur =
          typeof r.calendar.slotDuration === "number" &&
          r.calendar.slotDuration > 0
            ? r.calendar.slotDuration
            : 30;
        const durMin =
          r.calendar.slotDurationUnit === "hours" ? rawDur * 60 : rawDur;
        for (const [key, value] of Object.entries(r.raw)) {
          if (!value || !DATE_KEY.test(key)) continue;
          let slots: string[] = [];
          if (Array.isArray(value)) {
            slots = (value as unknown[]).filter(
              (s): s is string => typeof s === "string",
            );
          } else if (
            typeof value === "object" &&
            Array.isArray((value as { slots?: unknown }).slots)
          ) {
            slots = ((value as { slots: unknown[] }).slots).filter(
              (s): s is string => typeof s === "string",
            );
          }
          if (slots.length === 0) continue;
          if (!unionByDate[key]) unionByDate[key] = new Map();
          for (const s of slots) {
            const existing = unionByDate[key].get(s);
            if (existing) {
              existing.sources.set(r.calendar.id, durMin);
            } else {
              unionByDate[key].set(s, {
                sources: new Map([[r.calendar.id, durMin]]),
              });
            }
          }
        }
      }

      // 2. Coleta events onde rep é assignedUser (cross-calendar coverage)
      // Fix MED-5 (audit 2026-05-05): inverter pra positive list — evita
      // API drift quando GHL adicionar status novo (ex: "tentative") que
      // bot deveria respeitar como conflict mas exclude-list não conhecia.
      // Status confiáveis que CONTAM como conflict (resto = ignora).
      // Fix MED-4: rejeita event com endTime <= startTime (data corrupta
      // virava conflict universal — slotStart < hugeEnd && slotEnd > smallStart
      // sempre true → bot escondia o dia todo).
      // Fix MED-3: dedup por event.id (mesmo event aparecia 2x se rep é
      // assignee em 2 calendars colaborativos — conflicts_found inflado).
      const COUNTS_AS_CONFLICT = new Set([
        "scheduled", "confirmed", "showed", "rescheduled", "checked-in",
        "checked_in", "new", "open",
      ]);
      const seenEventIds = new Set<string>();
      const conflicts: Array<{ start: number; end: number; title?: string }> = [];
      for (const r of eventsResults) {
        for (const event of r.events) {
          if (event.assignedUserId !== repUserId) continue;
          const status = (event.appointmentStatus || "scheduled").toLowerCase();
          if (!COUNTS_AS_CONFLICT.has(status)) continue;
          const eStart = new Date(event.startTime).getTime();
          const eEnd = new Date(event.endTime).getTime();
          if (isNaN(eStart) || isNaN(eEnd)) continue;
          if (eEnd <= eStart) {
            console.warn(
              `[list_my_free_slots] Event ${event.id || "?"} tem endTime<=startTime (start=${event.startTime}, end=${event.endTime}) — ignorado.`,
            );
            continue;
          }
          if (event.id) {
            if (seenEventIds.has(event.id)) continue;
            seenEventIds.add(event.id);
          }
          conflicts.push({ start: eStart, end: eEnd, title: event.title });
        }
      }

      // Silent calendars: respondeu OK mas retornou ZERO slots em TODO
      // o range. Provavelmente admin-only (só admin cria appts, não exposto
      // pra cliente bookar) OU schedule diferente do default user.
      // Bug observado 2026-05-05: Marcos tem 7 calendars como team_member,
      // mas só 6 usam o "Work Hours" schedule (Mon-Thu 9-22). O 7º
      // ("Calendário - Agência") é admin-only — nunca retorna slot público.
      // INTERSECT-conservador antigo via "missing" + BH OK → suspect block,
      // escondendo slots GENUINAMENTE livres do rep.
      // Fix: silent calendars NÃO contam como "esperado" no INTERSECT.
      const silentCalendars = new Set<string>();
      for (const r of freeSlotsResults) {
        if (!r.ok) continue;
        const hasAnySlots = Object.entries(r.raw).some(([key, value]) => {
          if (!value || !DATE_KEY.test(key)) return false;
          if (Array.isArray(value)) {
            return (value as unknown[]).some((s) => typeof s === "string");
          }
          if (
            typeof value === "object" &&
            Array.isArray((value as { slots?: unknown }).slots)
          ) {
            return ((value as { slots: unknown[] }).slots).some(
              (s) => typeof s === "string",
            );
          }
          return false;
        });
        if (!hasAnySlots) silentCalendars.add(r.calendar.id);
      }

      // INTERSECT-conservador (B4/I2 best-effort): se slot tá em business
      // hours de N calendars do rep mas só K < N retornaram, K-N escondeu
      // — provável Google Calendar block escapando.
      //
      // Fix CRITICAL bug 2026-05-05 (validation re-review): antes usava
      // getUTC* mas openHours/daysOfTheWeek estão em LOCAL time do calendar.
      // Pra rep em EDT (UTC-4), slot 14:00 EDT = 18:00 UTC. Lendo getUTCHours
      // a função comparava 18 com close=18 → fora do BH → INTERSECT-conservador
      // virava no-op. Agora usa Intl.DateTimeFormat com tz pra extrair local
      // weekday/hour/minute corretos.
      function calendarHasOpenHoursAt(
        cal: typeof userCalendars[0],
        slotMs: number,
        tz: string,
      ): boolean {
        if (!cal.openHours || cal.openHours.length === 0) return true;
        // Extrai weekday/hour/minute no TIMEZONE do rep (não em UTC).
        // Assumimos calendar opera no mesmo tz da location/rep — case típico
        // (Brazillionaires reps em EDT/CDT/PDT, calendars criados na location).
        let wd: number, hh: number, mm: number;
        try {
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour12: false,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          const parts = fmt.formatToParts(new Date(slotMs));
          const get = (t: string) =>
            parts.find((p) => p.type === t)?.value || "";
          const wdMap: Record<string, number> = {
            Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
          };
          wd = wdMap[get("weekday")] ?? -1;
          hh = parseInt(get("hour"), 10);
          mm = parseInt(get("minute"), 10);
          // "24" pode aparecer pra meia-noite no en-US hour12:false — normaliza
          if (hh === 24) hh = 0;
        } catch {
          // Fail-safe: tz inválido, assume aberto pra não bloquear false-positive
          return true;
        }
        if (wd < 0 || isNaN(hh) || isNaN(mm)) return true;

        const slotMinOfDay = hh * 60 + mm;
        for (const block of cal.openHours) {
          if (!block.daysOfTheWeek.includes(wd)) continue;
          for (const range of block.hours) {
            const openMin = range.openHour * 60 + range.openMinute;
            const closeMin = range.closeHour * 60 + range.closeMinute;
            // Fix MED-1 (audit 2026-05-05): suporta overnight ranges
            // (ex: call center 22:00 → 02:00). closeMin <= openMin =
            // overnight: aberto de openMin até fim do dia OU início do
            // dia até closeMin. Sem isso, calendars noturnos eram tratados
            // como NUNCA abertos → INTERSECT escondia tudo.
            if (closeMin <= openMin) {
              if (slotMinOfDay >= openMin || slotMinOfDay < closeMin) {
                return true;
              }
            } else {
              if (slotMinOfDay >= openMin && slotMinOfDay < closeMin) {
                return true;
              }
            }
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
          if (isNaN(slotStart)) continue;

          // Fix HIGH-4: per-source conflict check. Slot só é removido
          // se TODAS as durations diferentes conflitam. Calendar A 30min
          // pode ter slot 14:00-14:30 livre mesmo se calendar B 60min
          // (14:00-15:00) conflita com event 14:30. Min duration mais
          // permissiva, evita esconder livre legítimo.
          const sourcesArr = Array.from(meta.sources.entries()); // [calId, dur]
          const allSourcesConflict = sourcesArr.every(([, durMin]) => {
            const slotEnd = slotStart + durMin * 60_000;
            return conflicts.some(
              (c) => slotStart < c.end && slotEnd > c.start,
            );
          });
          if (allSourcesConflict) {
            removedConflict++;
            continue;
          }

          // INTERSECT-conservador SOMENTE se 3+ userCalendars (era 2+).
          // Fix bug observado em prod 2026-05-05 (caso Marcos via screenshot
          // visual): threshold antigo "1+ missing" era too eager — escondia
          // slots GENUINAMENTE livres como suspect blocks.
          // Agora: (a) ignora silent calendars (admin-only), (b) precisa de
          // 3+ baseline pra ter sample size, (c) só suspect se 50%+ dos
          // calendars-com-BH faltarem. Mantém detecção de Google block real
          // (que tipicamente afeta TODOS os calendars do rep) sem falso-
          // positivo em calendar com config idiossincrática.
          if (userCalendars.length >= 3) {
            const calsWithBH = userCalendars.filter(
              (c) =>
                userCalendarsResponded.has(c.id) &&
                !silentCalendars.has(c.id) &&
                calendarHasOpenHoursAt(c, slotStart, repTimezone),
            );
            // Fix MED-9: count only sources that estão tb em calsWithBH
            // (silent calendar como source não conta no baseline).
            const calsWithBHIds = new Set(calsWithBH.map((c) => c.id));
            const calsReturningWithBH = sourcesArr.filter(([id]) =>
              calsWithBHIds.has(id),
            ).length;
            const missingCount = calsWithBH.length - calsReturningWithBH;
            const missingRatio =
              calsWithBH.length > 0 ? missingCount / calsWithBH.length : 0;
            if (
              calsWithBH.length >= 3 &&
              missingRatio >= 0.5
            ) {
              const missing = calsWithBH
                .filter((c) => !meta.sources.has(c.id))
                .map((c) => c.name || c.id);
              removedSuspectBlock++;
              if (suspectBlockExamples.length < 3) {
                suspectBlockExamples.push(
                  `${slotIso} (esperado em ${calsWithBH.length}, retornou em ${calsReturningWithBH}; missing: ${missing.slice(0, 2).join(", ")})`,
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

      // Fix MEDIUM bug 2026-05-05 (validation re-review) + CRIT-2 (audit):
      // se TODOS os event calendars falharam OU retornaram payload corrompido,
      // status:ok era enganoso — bot apresentava slots como livres sem ter
      // conseguido detectar conflicts. Agora status muda pra "degraded" e
      // warning fica crítico (LLM tem que confirmar com rep antes de marcar).
      // Inclui missing field (silent GHL corruption — 200 OK sem events array).
      // 404s (calendar deletado) NÃO contam como degradation.
      const eventsBadResults = eventsFailed + eventsMissingField;
      const allEventsBad =
        eventCalendars.length > 0 &&
        eventsBadResults > 0 &&
        eventsBadResults + eventsNotFound === eventCalendars.length;

      return {
        status: allEventsBad ? "degraded" : "ok",
        data: {
          slots_by_date: filteredByDate,
          total_slots: totalSlots,
          calendars_checked: validCalendarNames.length,
          calendar_names: validCalendarNames,
          conflicts_found: conflicts.length,
          slots_removed_conflicts: removedConflict,
          slots_removed_suspect_block: removedSuspectBlock,
          suspect_block_examples: suspectBlockExamples,
          partial: eventsBadResults > 0 || truncatedCalendars,
          partial_calendars_failed: eventsFailed,
          partial_calendars_missing_field: eventsMissingField,
          partial_calendars_not_found: eventsNotFound,
          partial_total_event_calendars: eventCalendars.length,
          truncated_calendars: truncatedCalendars,
          all_events_failed: allEventsBad,
          silent_calendars: Array.from(silentCalendars).map(
            (id) =>
              userCalendars.find((c) => c.id === id)?.name || id,
          ),
          window: {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            timezone: repTimezone,
          },
          source:
            "USER-CENTRIC: UNION /free-slots dos rep's calendars (com userId p/ round-robin) MENOS events cross-calendar onde assignedUserId=rep. INTERSECT-conservador remove slots suspeitos de Google block (slot ausente de calendar com business hours coverage).",
          warning_google_calendar:
            "Best-effort detection de Google Calendar blocks via INTERSECT. Pode escapar se rep tem agenda Google pessoal NÃO integrada — confirma no Spark Leads UI antes de marcar.",
          warning_partial: allEventsBad
            ? `⚠️ CRÍTICO: TODOS os ${eventCalendars.length} calendars falharam (failed=${eventsFailed}, missing_field=${eventsMissingField}, not_found=${eventsNotFound}) — NÃO consegui detectar conflicts cross-calendar nem appointments existentes. Trate slots como POSSIVELMENTE livres apenas, e CONFIRME com rep + Spark Leads UI ANTES de marcar.`
            : eventsBadResults > 0
              ? `${eventsBadResults} de ${eventCalendars.length} calendars falharam ao retornar events (failed=${eventsFailed}, missing_field=${eventsMissingField}) — alguns conflicts podem ter sido perdidos. Confirma com rep antes de marcar slot crítico.`
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
      const res = await ghlGetAppointment(ctx.ghlClient, appointmentId);
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
      "⚠️ AGENDA reunião pra um contato no calendário. AFETA o lead — sempre confirma com o rep ANTES. Use get_free_slots pra escolher horário válido.\n\n" +
      "Observação importante: pra calendars **round-robin/collective/group** (com vários team members), NÃO passe `assigned_user_id` — deixe o Spark Leads escolher automaticamente. Pra calendars **personal/service** (1 user só), opcional. Default: não passar (mais seguro pra qualquer tipo de calendar).\n\n" +
      "⚙️ MEETING LOCATION (qualquer rep): se rep especificar onde/como — 'Zoom', 'Google Meet', 'presencial em [endereço]', 'telefone [num]', 'link [url]' — passe `meeting_location_type` E `meeting_location`. Sem isso, o Spark Leads ignora silenciosamente e usa default do calendar (bug histórico pré-H26).\n\n" +
      "⚙️ OVERRIDE ADMIN (apenas internal team): se rep admin pedir pra forçar slot bloqueado (`ignore_free_slot_validation`), ignorar minimum notice (`ignore_date_range`), ou marcar sem notificação (`to_notify=false`), SEMPRE explicite o override na frase de confirmação: 'Vou marcar X mesmo com slot bloqueado — confirma?'. NUNCA use silenciosamente. Rep não-admin recebe erro do gate.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        contact_id: { type: "string" },
        start_time: { type: "string", description: "ISO 8601" },
        end_time: { type: "string", description: "ISO 8601" },
        title: { type: "string" },
        meeting_location_type: {
          type: "string",
          description:
            "OPCIONAL. Tipo de local da reunião. Valores: 'zoom' | 'gmeet' | 'phone' | 'address' | 'custom'. " +
            "Passar este param ativa overrideLocationConfig automaticamente — o Spark Leads respeita o local que você manda em vez do default do calendar.",
        },
        meeting_location: {
          type: "string",
          description:
            "OPCIONAL. Link/endereço/telefone literal (ex: 'https://zoom.us/j/abc', 'Av. Paulista 100', '+5511987654321'). " +
            "Use quando rep especificar link/endereço próprio. Pra 'zoom'/'gmeet' SEM link específico, omita — o Spark Leads gera automático.",
        },
        assigned_user_id: {
          type: "string",
          description:
            "OPCIONAL. ID do user a quem atribuir a reunião. Use APENAS se o rep pedir explicitamente OU se for um calendar personal de 1 user específico. Pra round-robin/collective/group, OMITA — Spark Leads escolhe automaticamente baseado em disponibilidade.",
        },
        // H26 (review 2026-05-14): override flags admin-only — bypassam
        // validações destrutivas do Spark Leads. Gate em buildOverridePayload.
        ignore_free_slot_validation: {
          type: "boolean",
          description:
            "OPCIONAL (admin only). Força marcação EM CIMA de slot bloqueado/conflict. " +
            "Use APENAS quando rep admin pedir explicitamente ('força', 'mesmo bloqueado', 'ignora bloqueio'). " +
            "Na confirmação verbal, deixe claro que está IGNORANDO um bloqueio.",
        },
        ignore_date_range: {
          type: "boolean",
          description:
            "OPCIONAL (admin only). Pula 'minimum scheduling notice' do calendar (ex: calendar exige 2h+ no futuro). " +
            "Use quando rep admin diz 'marca pra agora' / 'marca pra hoje' e o horário rejeita por min notice.",
        },
        to_notify: {
          type: "boolean",
          description:
            "OPCIONAL (admin only, default true). Passe `false` quando rep admin pedir explicitamente 'marca sem mandar notificação' ou 'sem disparar automation'. " +
            "⚠️ DRÁSTICO — cliente NÃO recebe lembrete/invite. Confirme separadamente antes de usar.",
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

    // H26 (review 2026-05-14): gate admin pras 3 flags destrutivas.
    const overrideResult = buildOverridePayload(ctx, args);
    if (!overrideResult.ok) return overrideResult.error;

    // Fix bug "self" literal observado em prod 2026-05-11 (signal HIGH 2 hits):
    // LLM mandava `assigned_user_id: "self"` como string em vez de resolver
    // pro ghl_user_id real. GHL rejeitava com 422 "user id not part of
    // calendar team". Helper resolve 'self'/'me'/'eu' → rep ativo.
    const resolvedUser = resolveAssignedUserId(ctx, args.assigned_user_id);
    if (!resolvedUser.ok) return resolvedUser.error;
    let assignedUserId = resolvedUser.user_id;

    // Fix Pedro 2026-05-19 (caso Bela Castro 15:32): LLM passou user_id de
    // "Pedro Poleza" que veio de uma lista de users de OUTRA location
    // (caché stale ou troca de location no meio do turn). GHL retornou 422
    // "user id not part of calendar team". Pedro corrigiu manualmente
    // passando o user_id certo.
    //
    // Safety: se rep TEM mapping conhecido em rep.ghl_users[locationId] e o
    // assigned_user_id passado é DIFERENTE, prefira o mapping conhecido
    // (mais confiável que lista de users que pode estar contaminada).
    // O override SÓ ocorre se rep não passou explicitamente outro user
    // (ex: "marca pro João" vs default "marca pra mim").
    const knownRepUserId = getRepGhlUserId(ctx);
    if (
      assignedUserId &&
      knownRepUserId &&
      assignedUserId !== knownRepUserId &&
      ctx.rep.is_internal // só faz override pra rep internal (eles costumam ser admin/owner)
    ) {
      console.warn(
        `[create_appointment] user_id mismatch: passed=${assignedUserId} known=${knownRepUserId} loc=${ctx.locationId} rep=${ctx.rep.id}. Usando o known.`,
      );
      assignedUserId = knownRepUserId;
    }

    // H26 (review 2026-05-14): auto-ativa overrideLocationConfig quando rep
    // especifica meeting location. Sem isso, GHL ignora silenciosamente
    // meetingLocationType/address e usa default do calendar — bug histórico.
    const hasCustomMeetingLocation =
      args.meeting_location_type !== undefined ||
      args.meeting_location !== undefined;

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
        ...(hasCustomMeetingLocation ? { overrideLocationConfig: true } : {}),
        ...(assignedUserId ? { assignedUserId } : {}),
        ...overrideResult.body, // H26 admin flags — spread no fim pra garantir prioridade
      };

      const res = await ghlCreateAppointment(ctx.ghlClient, body);
      const apptId = res.id || res.appointment?.id;

      // H26 audit: signal só pras flags admin (não pro meeting location override).
      // Fingerprint ESTÁVEL (sem apptId no title) → recorder dedupa via
      // sha256(type+title), vira counter natural no painel.
      if (overrideResult.used.length > 0) {
        recordSignalAsync({
          type: "idea",
          title: `Calendar override admin (${overrideResult.used.sort().join("+")})`,
          description: `Admin usou override flags em create_appointment: ${overrideResult.used.join(", ")}`,
          severity: "low",
          source: "bot_auto",
          metadata: {
            tool: "create_appointment",
            appointment_id: apptId,
            rep_id: ctx.rep.id,
            rep_phone: ctx.rep.phone,
            location_id: ctx.locationId,
            calendar_id: calendarId,
            contact_id: contactId,
            override_flags_used: overrideResult.used,
          },
        });
      }

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
      // quer tentar com X ou Y?"). Usa variável `assignedUserId` resolvida
      // (não args raw) — evita comparar contra "self" literal.
      const errMsg = err instanceof Error ? err.message : String(err);
      const isSlotBlock = /slot.*not.*available|no longer available/i.test(errMsg);
      if (assignedUserId && isSlotBlock) {
        try {
          const calRes = await getCalendarDetails(ctx.ghlClient, calendarId);
          const others = (calRes.calendar?.teamMembers || [])
            .map((tm) => tm.userId)
            .filter((id): id is string => !!id && id !== assignedUserId);
          if (others.length > 0) {
            const repUser = getRepGhlUserId(ctx);
            return {
              status: "error",
              message:
                `O horário tá bloqueado pro user ${assignedUserId}` +
                (assignedUserId === repUser ? " (você)" : "") +
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

    // Fix bug "self" literal 2026-05-14: helper resolveAssignedUserId aceita
    // 'self'/'me'/'eu' e resolve pro rep, valida UUID se passado explícito.
    const resolved = resolveAssignedUserId(ctx, args.assigned_user_id);
    if (!resolved.ok) return resolved.error;
    const targetUser = resolved.user_id || getRepGhlUserId(ctx);
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
      const res = await createBlockSlot(ctx.ghlClient, body);
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
    description:
      "⚠️ Reagendar um appointment existente (mudar horário, status, OU meeting location). Confirma antes.\n\n" +
      "⚙️ MEETING LOCATION (qualquer rep): se rep pedir pra TROCAR o local da reunião ('agora vai ser presencial', 'muda pra Google Meet', 'manda link do meu Zoom em vez do default'), passe `meeting_location_type` + `meeting_location`. Sem isso, o Spark Leads ignora silenciosamente.\n\n" +
      "⚙️ OVERRIDE ADMIN (apenas internal team): se rep admin pedir pra REagendar em cima de bloqueio (`ignore_free_slot_validation`), pra horário fora do min notice (`ignore_date_range`), ou sem mandar notificação (`to_notify=false`), SEMPRE explicite na confirmação: 'Vou mover pra X mesmo bloqueado — confirma?'. NUNCA silencioso. Rep não-admin recebe erro do gate.",
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
        // H26 (review 2026-05-14): meeting location override (qualquer rep)
        meeting_location_type: {
          type: "string",
          description:
            "OPCIONAL. 'zoom' | 'gmeet' | 'phone' | 'address' | 'custom'. Ativa overrideLocationConfig auto.",
        },
        meeting_location: {
          type: "string",
          description:
            "OPCIONAL. Link/endereço/telefone literal pro novo meeting location. " +
            "Pra 'zoom'/'gmeet' SEM link específico, omita — o Spark Leads gera automático.",
        },
        // H26: admin override flags
        ignore_free_slot_validation: {
          type: "boolean",
          description: "OPCIONAL (admin only). Força reagendamento em slot bloqueado/conflict.",
        },
        ignore_date_range: {
          type: "boolean",
          description: "OPCIONAL (admin only). Pula min notice ao reagendar pra horário próximo.",
        },
        to_notify: {
          type: "boolean",
          description: "OPCIONAL (admin only). `false` = sem notificação do reagendamento. ⚠️ DRÁSTICO.",
        },
      },
      required: ["appointment_id"],
    },
  },
  handler: async (ctx, args) => {
    const appointmentId = String(args.appointment_id || "");
    const invalid = validateGhlId(appointmentId, "appointment");
    if (invalid) return invalid;

    // H26 (review 2026-05-14): gate admin pras 3 flags destrutivas.
    const overrideResult = buildOverridePayload(ctx, args);
    if (!overrideResult.ok) return overrideResult.error;

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

    // H26 (review 2026-05-14): meeting location override auto-ativado.
    // Sem overrideLocationConfig=true, GHL descartaria silenciosamente.
    if (args.meeting_location_type !== undefined) {
      body.meetingLocationType = String(args.meeting_location_type);
    }
    if (args.meeting_location !== undefined) {
      body.address = String(args.meeting_location);
    }
    if (args.meeting_location_type !== undefined || args.meeting_location !== undefined) {
      body.overrideLocationConfig = true;
    }

    // H26: admin override flags
    Object.assign(body, overrideResult.body);

    if (Object.keys(body).length === 0) {
      return { status: "error", message: "Nenhum campo pra atualizar", retryable: false };
    }

    try {
      await ghlUpdateAppointment(ctx.ghlClient, appointmentId, body);

      // H26 audit: signal pras flags admin (não pra meeting location).
      // Fingerprint estável → counter natural no painel /admin/signals.
      if (overrideResult.used.length > 0) {
        recordSignalAsync({
          type: "idea",
          title: `Calendar override admin (${overrideResult.used.sort().join("+")})`,
          description: `Admin usou override flags em update_appointment: ${overrideResult.used.join(", ")}`,
          severity: "low",
          source: "bot_auto",
          metadata: {
            tool: "update_appointment",
            appointment_id: appointmentId,
            rep_id: ctx.rep.id,
            rep_phone: ctx.rep.phone,
            location_id: ctx.locationId,
            override_flags_used: overrideResult.used,
          },
        });
      }

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
      await ghlDeleteAppointment(ctx.ghlClient, appointmentId);
      return { status: "ok", data: { deleted: appointmentId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de appointment");
    }
  },
};

// =====================================================================
// PREFERÊNCIA DE AGENDAMENTO (Agendamento V2 — D2, Pedro 2026-05-22)
// =====================================================================
// Bot APRENDE no 1º uso: depois de marcar com sucesso num calendário que o
// rep não tinha salvo, ele pergunta 1× "uso esse calendário sempre que você
// marcar?" e, no sim, chama esta tool. Também é o que a UI do Spark (E4) grava.
// Resolução no agendamento: nome dito > esta pref > único calendário.

const setSchedulingPref: ToolEntry = {
  def: {
    name: "set_scheduling_pref",
    description:
      "Salva a preferência de agendamento do rep: calendário padrão (e, " +
      "opcional, duração padrão da reunião). Use quando o rep confirmar que " +
      "quer SEMPRE usar um calendário pra marcar (ex: ele respondeu 'sim, usa " +
      "esse sempre' depois de você perguntar). Depois disso você não precisa " +
      "mais perguntar qual calendário — já agenda nele direto.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        default_calendar_id: {
          type: "string",
          description: "ID do calendário padrão (pegue de list_calendars).",
        },
        default_duration_min: {
          type: "number",
          description:
            "Opcional. Duração padrão da reunião em minutos (ex: 30, 60). " +
            "Se omitido, usa a duração configurada no próprio calendário.",
        },
      },
      required: ["default_calendar_id"],
    },
  },
  handler: async (ctx, args) => {
    const calendarId = String(args.default_calendar_id || "").trim();
    const idErr = validateGhlId(calendarId, "calendar");
    if (idErr) return idErr;

    // Valida que o calendário existe na location ativa e pega o nome (pra
    // surfacing na memória do prompt sem tool call depois).
    let calendarName: string | undefined;
    try {
      const res = await ghlListCalendars(ctx.ghlClient, ctx.locationId);
      const match = (res.calendars || []).find((c) => c.id === calendarId);
      if (!match) {
        return {
          status: "error",
          message:
            "Esse calendário não existe nesta conta do Spark Leads. Liste os " +
            "calendários (list_calendars) e escolha um válido.",
          retryable: false,
        };
      }
      calendarName = match.name;
    } catch (err) {
      return ghlErrorToResult(err, "validação do calendário");
    }

    // Duração: aceita só valores sãos (5min–8h). Fora disso, ignora.
    let durationMin: number | undefined;
    if (typeof args.default_duration_min === "number" && isFinite(args.default_duration_min)) {
      const d = Math.round(args.default_duration_min);
      if (d >= 5 && d <= 480) durationMin = d;
    }

    // Merge manual das preferences pra NÃO clobberar verbosity/tone/aliases.
    // Mesmo padrão de set_verbosity_preference (identity.ts).
    const currentProfile = (ctx.rep.profile || {}) as Record<string, unknown>;
    const currentPrefs = (currentProfile.preferences || {}) as Record<string, unknown>;
    const currentScheduling = (currentPrefs.scheduling || {}) as Record<string, unknown>;
    const newScheduling: Record<string, unknown> = {
      ...currentScheduling,
      default_calendar_id: calendarId,
      default_calendar_name: calendarName,
    };
    if (durationMin !== undefined) newScheduling.default_duration_min = durationMin;
    const newProfile = {
      ...currentProfile,
      preferences: { ...currentPrefs, scheduling: newScheduling },
    };

    try {
      await updateRepById(ctx.rep.id, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        profile: newProfile as any,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `Falha ao salvar preferência: ${msg}`, retryable: true };
    }
    ctx.rep.profile = newProfile as typeof ctx.rep.profile;

    return {
      status: "ok",
      data: {
        default_calendar_id: calendarId,
        default_calendar_name: calendarName,
        default_duration_min: durationMin,
        message:
          `Pronto, vou usar o calendário "${calendarName}" por padrão pra marcar` +
          (durationMin ? ` (reuniões de ${durationMin}min)` : "") +
          ". Se quiser trocar depois, é só falar.",
      },
    };
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
  setSchedulingPref,
];
