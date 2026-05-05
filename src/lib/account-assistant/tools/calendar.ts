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
      return {
        status: "ok",
        data: (res.events || []).map((e) => ({
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
      "Lista horários disponíveis num calendário, dentro de uma janela. Use ANTES de create_appointment pra não tentar agendar horário ocupado.",
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

    try {
      const res = await ctx.ghlClient.get<Record<string, { slots?: string[] }>>(
        `/calendars/${calendarId}/free-slots`,
        {
          startDate: String(startMs),
          endDate: String(endMs),
          ...(args.timezone ? { timezone: String(args.timezone) } : {}),
        },
      );
      const slotsByDate: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(res)) {
        if (key === "traceId" || !value) continue;
        const slots = Array.isArray(value) ? (value as unknown as string[]) : value.slots || [];
        if (slots.length > 0) slotsByDate[key] = slots;
      }
      return { status: "ok", data: { slots_by_date: slotsByDate } };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de horários disponíveis");
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
        appointment_status: { type: "string", description: "Ex: 'confirmed', 'showed', 'noshow', 'cancelled'." },
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
    if (args.appointment_status) body.appointmentStatus = String(args.appointment_status);
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
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  blockCalendarSlot,
];
