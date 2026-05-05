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
      "Lista horários disponíveis num calendário, dentro de uma janela. Use ANTES de create_appointment pra não tentar agendar horário ocupado.\n\nFEAT 2026-05-05: cross-calendar check — agora subtrai conflitos de TODOS os calendars do user (não só o calendar passado). Resolve caso de rep ter appointment em calendar A e cliente quer agendar no calendar B no mesmo horário. Aviso sobre Google Calendar não-sincronizado retornado via meta.",
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

    // Fix Track 3 #14 (review 2026-05-05): validar end > start + max 7 dias.
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
      // FEAT 2026-05-05 cross-calendar conflict check (caso cliente Marcos):
      // 1. Query /free-slots do calendar requested (já considera Google sync
      //    pra esse calendar específico).
      // 2. Em paralelo, list calendars do user + query /events de cada
      //    pra coletar conflitos cross-calendar.
      // 3. Subtrai client-side os slots que conflitam.
      // Não cobre: Google Calendar blocks que não sincronizaram com GHL
      // (rep precisa ativar integração no GHL Settings).
      const [freeSlotsRes, calendarsRes] = await Promise.all([
        ctx.ghlClient.get<Record<string, { slots?: string[] }>>(
          `/calendars/${calendarId}/free-slots`,
          {
            startDate: String(startMs),
            endDate: String(endMs),
            ...(args.timezone ? { timezone: String(args.timezone) } : {}),
          },
        ),
        repUserId
          ? ctx.ghlClient
              .get<{
                calendars?: Array<{ id: string; teamMembers?: Array<{ userId: string }> }>;
              }>("/calendars/", { locationId: ctx.locationId })
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      // Extrai os slots iniciais (já considera Google sync interno do calendar)
      const slotsByDate: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(freeSlotsRes)) {
        if (key === "traceId" || !value) continue;
        const slots = Array.isArray(value) ? (value as unknown as string[]) : value.slots || [];
        if (slots.length > 0) slotsByDate[key] = slots;
      }

      // Coleta conflitos cross-calendar — só rola se temos repUserId
      const conflicts: Array<{ start: number; end: number }> = [];
      let calendarsChecked = 0;
      if (repUserId && calendarsRes) {
        const userCalendars = (calendarsRes.calendars || []).filter((c) =>
          (c.teamMembers || []).some((tm) => tm.userId === repUserId),
        );
        // Excluir o calendar requested (já coberto pelo /free-slots)
        const otherCalendars = userCalendars.filter((c) => c.id !== calendarId);
        const eventsResults = await Promise.all(
          otherCalendars.map((c) =>
            ctx.ghlClient
              .get<{
                events?: Array<{
                  startTime: string;
                  endTime: string;
                  appointmentStatus?: string;
                }>;
              }>("/calendars/events", {
                locationId: ctx.locationId,
                calendarId: c.id,
                startTime: String(startMs),
                endTime: String(endMs),
                userId: repUserId,
              })
              .catch(() => null),
          ),
        );
        for (const result of eventsResults) {
          if (!result?.events) continue;
          calendarsChecked++;
          for (const event of result.events) {
            const status = (event.appointmentStatus || "scheduled").toLowerCase();
            if (status === "cancelled" || status === "noshow" || status === "invalid") continue;
            const eStart = new Date(event.startTime).getTime();
            const eEnd = new Date(event.endTime).getTime();
            if (isNaN(eStart) || isNaN(eEnd)) continue;
            conflicts.push({ start: eStart, end: eEnd });
          }
        }
      }

      // Filtra slots que colidem com conflicts cross-calendar.
      // Assume slot duration = próximo slot - este (ou 30min se único).
      let removedCount = 0;
      const filteredByDate: Record<string, string[]> = {};
      for (const [date, slots] of Object.entries(slotsByDate)) {
        const filtered: string[] = [];
        for (let i = 0; i < slots.length; i++) {
          const slotStart = new Date(slots[i]).getTime();
          // Heurística de duração: 30min default. Slots típicos GHL.
          const slotEnd = slotStart + 30 * 60_000;
          const conflicts_hit = conflicts.some(
            (c) => slotStart < c.end && slotEnd > c.start,
          );
          if (conflicts_hit) {
            removedCount++;
          } else {
            filtered.push(slots[i]);
          }
        }
        if (filtered.length > 0) filteredByDate[date] = filtered;
      }

      return {
        status: "ok",
        data: {
          slots_by_date: filteredByDate,
          cross_calendar_check: {
            calendars_scanned: calendarsChecked,
            conflicts_found: conflicts.length,
            slots_removed: removedCount,
          },
          warning_google_calendar:
            "Se o rep tem agenda Google pessoal NÃO integrada no Spark Leads, blocks dela podem não aparecer aqui. Pra integrar: Settings → My Profile → Calendar Connection na conta dele.",
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de horários disponíveis");
    }
  },
};

const listMyFreeSlots: ToolEntry = {
  def: {
    name: "list_my_free_slots",
    description:
      "Lista horários LIVRES do REP num período (hoje/amanhã/semana). Combina /free-slots de TODOS os calendars onde rep é team_member, considerando appointments de outros users + blocks manuais + Google Calendar synced. Use SEMPRE quando rep pergunta 'que horários eu tenho livres', 'qual horários disponiveis', 'tô livre quando' etc.\n\n⚠️ NUNCA calcule horários livres a partir de list_appointments — esse só retorna appointments NATIVOS do Spark Leads, perde Google Calendar blocks. Esta tool é a única correta.",
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

    const now = new Date();
    let startMs: number, endMs: number;
    if (when === "today") {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      startMs = s.getTime(); endMs = e.getTime();
    } else if (when === "tomorrow") {
      const s = new Date(now); s.setDate(s.getDate() + 1); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setHours(23, 59, 59, 999);
      startMs = s.getTime(); endMs = e.getTime();
    } else if (when === "next_week") {
      const s = new Date(now); s.setDate(s.getDate() + 7); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setDate(e.getDate() + 7); e.setHours(23, 59, 59, 999);
      startMs = s.getTime(); endMs = e.getTime();
    } else {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      startMs = s.getTime();
      const e = new Date(s); e.setDate(e.getDate() + 7);
      endMs = e.getTime();
    }

    try {
      // Lista calendars onde rep é team_member
      const calRes = await ctx.ghlClient.get<{
        calendars?: Array<{
          id: string;
          name?: string;
          teamMembers?: Array<{ userId: string }>;
        }>;
      }>("/calendars/", { locationId: ctx.locationId });

      const userCalendars = (calRes.calendars || []).filter((c) =>
        (c.teamMembers || []).some((tm) => tm.userId === repUserId),
      );

      if (userCalendars.length === 0) {
        return {
          status: "not_found",
          message: "Você não é team_member de nenhum calendar nesta location.",
        };
      }

      // Query /free-slots de cada calendar em paralelo. Cada um já considera
      // Google Calendar blocks daquele calendar específico (testado em prod
      // 2026-05-05 — calendars com integration retornam slots respeitando).
      const freeSlotsResults = await Promise.all(
        userCalendars.map((c) =>
          ctx.ghlClient
            .get<Record<string, { slots?: string[] }>>(
              `/calendars/${c.id}/free-slots`,
              {
                startDate: String(startMs),
                endDate: String(endMs),
              },
            )
            .then((res) => ({ calendar: c, raw: res }))
            .catch(() => null),
        ),
      );

      // Coleta slots de cada calendar como Set por data, depois INTERSECTA
      // (slot livre = todos calendars do rep concordam que tá livre).
      // Heurística: comparar por timestamp ISO exato. Se um calendar tem
      // slots de 30min e outro de 1h, intersect pode ser zero. Trade-off:
      // ser conservador, listar só slots em comum.
      const slotsByCalendar: Array<{ name: string; byDate: Record<string, Set<string>> }> = [];
      for (const r of freeSlotsResults) {
        if (!r) continue;
        const byDate: Record<string, Set<string>> = {};
        for (const [key, value] of Object.entries(r.raw)) {
          if (key === "traceId" || !value) continue;
          const slots = Array.isArray(value) ? (value as unknown as string[]) : value.slots || [];
          if (slots.length > 0) byDate[key] = new Set(slots);
        }
        slotsByCalendar.push({ name: r.calendar.name || r.calendar.id, byDate });
      }

      if (slotsByCalendar.length === 0) {
        return {
          status: "not_found",
          message: "Nenhum calendar do rep retornou slots.",
        };
      }

      // Intersect across calendars: pra cada data, slot só é livre se TODOS
      // os calendars devolvem ele
      const intersected: Record<string, string[]> = {};
      const allDates = new Set<string>();
      for (const c of slotsByCalendar) {
        for (const d of Object.keys(c.byDate)) allDates.add(d);
      }
      for (const date of allDates) {
        // pega o conjunto inicial do primeiro calendar
        const firstCal = slotsByCalendar[0];
        if (!firstCal.byDate[date]) continue; // primeiro calendar não tem essa data → ninguém livre
        let common = new Set(firstCal.byDate[date]);
        for (let i = 1; i < slotsByCalendar.length; i++) {
          const cal = slotsByCalendar[i];
          if (!cal.byDate[date]) {
            // Calendar não tem essa data — significa "tudo ocupado" pra ele
            common = new Set();
            break;
          }
          // intersect
          const next = new Set<string>();
          for (const slot of common) {
            if (cal.byDate[date].has(slot)) next.add(slot);
          }
          common = next;
          if (common.size === 0) break;
        }
        if (common.size > 0) {
          intersected[date] = Array.from(common).sort();
        }
      }

      return {
        status: "ok",
        data: {
          slots_by_date: intersected,
          calendars_checked: slotsByCalendar.length,
          calendar_names: slotsByCalendar.map((c) => c.name),
          source: "intersection across all rep's calendars (considera Google Calendar blocks via /free-slots interno)",
          warning_google_calendar:
            "Se o rep tem agenda Google pessoal NÃO integrada no Spark Leads, blocks dela podem não aparecer. Ativar em Settings → My Profile → Calendar Connection.",
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
