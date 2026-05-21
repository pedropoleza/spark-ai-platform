/**
 * Primitivas de operações GHL compartilhadas entre os 3 agentes da plataforma.
 *
 * Antes desse módulo, sales/recruitment (action-executor.ts) e Sparkbot
 * (tools/contacts.ts, tools/tags.ts, etc) duplicavam a mesma chamada GHL
 * (add_tag em 3 lugares). Quando GHL muda spec ou descobrimos um bug
 * (tipo o `completed: false` obrigatório no create_task), tinha que
 * fixar 3 vezes.
 *
 * Aqui só primitivas thin (1 chamada GHL por função). Lógica de orquestração
 * (ex: "achar appointment futuro antes de book", "detectar booking error
 * conflict") fica nos callers.
 *
 * Reference: _planning/ghl-api-reference.md
 */

import type { GHLClient } from "./client";

const STANDARD_CONTACT_FIELDS = new Set([
  "firstName", "lastName", "name", "email", "phone",
  "address1", "city", "state", "postalCode", "country",
  "companyName", "dateOfBirth", "timezone", "website",
]);

// =====================================================
// Tags
// =====================================================

export async function addTagsToContact(
  client: GHLClient,
  contactId: string,
  tags: string[],
): Promise<void> {
  await client.post(`/contacts/${contactId}/tags`, { tags });
}

export async function removeTagsFromContact(
  client: GHLClient,
  contactId: string,
  tags: string[],
): Promise<void> {
  await client.delete(`/contacts/${contactId}/tags`, { tags });
}

// =====================================================
// Custom Fields / Standard Fields
// =====================================================

/**
 * Atualiza um campo do contato. Detecta automaticamente se é standard
 * ou custom baseado no field_key. Custom fields usam array `customFields`
 * com `{ id, value }` no body do PUT /contacts/{id}.
 */
export async function updateContactField(
  client: GHLClient,
  contactId: string,
  fieldKey: string,
  value: string,
): Promise<void> {
  const body: Record<string, unknown> = STANDARD_CONTACT_FIELDS.has(fieldKey)
    ? { [fieldKey]: value }
    : { customFields: [{ id: fieldKey, value }] };
  await client.put(`/contacts/${contactId}`, body);
}

// =====================================================
// Notes
// =====================================================

export async function createNoteOnContact(
  client: GHLClient,
  contactId: string,
  body: string,
): Promise<{ noteId?: string }> {
  const res = await client.post<{ id?: string; note?: { id: string } }>(
    `/contacts/${contactId}/notes`,
    { body },
  );
  return { noteId: res.id || res.note?.id };
}

// =====================================================
// Assigned user (owner) management
// =====================================================

/**
 * Garante que o `assignedTo` do contato está setado pro `targetUserId`.
 * Idempotente: fetch contato, se já tá assigned no target, no-op.
 * Senão, PUT /contacts/{id} setando assignedTo.
 *
 * POR QUE EXISTE: Pedro 2026-05-06 — contas com múltiplas instâncias
 * WhatsApp ativas roteiam a mensagem outbound baseado no `assignedTo`
 * do contato. Se o rep que pediu o envio NÃO é o assignee, a msg vai
 * pelo número de outro rep (errado, confuso). PROTOCOLO PADRÃO: antes
 * de QUALQUER send_message (agora ou agendado), bot muda assignedTo
 * pro user que pediu, garantindo que a msg sai pelo número correto.
 *
 * IMPORTANTE — propagation delay: o GHL roteia outbound consultando
 * o `assignedTo` cacheado em vários sistemas internos. Se POST de
 * conversations/messages vier <2s após PUT do assignedTo, a msg pode
 * sair pelo assignee ANTIGO (race condition observada por Pedro
 * 2026-05-06 — assigned trocado mas msg saiu pelo número errado).
 *
 * Pra mitigar: quando o switch ACONTECE (changed=true), aguarda
 * `propagationWaitMs` (default 5s) antes de retornar. Caller pode
 * confiar que ao retornar, o switch já se propagou. Quando changed=false
 * (já estava correto), no-op imediato.
 *
 * Retorna {changed, previousAssignedTo} pra audit/log no caller.
 */
export async function ensureContactAssignedTo(
  client: GHLClient,
  contactId: string,
  targetUserId: string,
  propagationWaitMs: number = 5_000,
): Promise<{ changed: boolean; previousAssignedTo: string | null }> {
  if (!targetUserId) {
    return { changed: false, previousAssignedTo: null };
  }
  try {
    const res = await client.get<{
      contact?: { assignedTo?: string };
    }>(`/contacts/${contactId}`);
    const current = res.contact?.assignedTo || null;
    if (current === targetUserId) {
      // Já está com assignment correto — no-op, sem espera
      return { changed: false, previousAssignedTo: current };
    }
    await client.put(`/contacts/${contactId}`, { assignedTo: targetUserId });
    // Fix Pedro 2026-05-06 (race observada): GHL precisa de tempo pra
    // propagar o novo assignedTo nos sistemas internos de routing
    // outbound. Sem essa espera, msg pode sair pelo número antigo.
    if (propagationWaitMs > 0) {
      await new Promise((r) => setTimeout(r, propagationWaitMs));
    }
    return { changed: true, previousAssignedTo: current };
  } catch (err) {
    // Não fatal — caller decide se continua com send mesmo assim.
    // Log pra observabilidade.
    console.warn(
      `[ensureContactAssignedTo] falhou pra contact=${contactId} target=${targetUserId}:`,
      err instanceof Error ? err.message.slice(0, 100) : err,
    );
    throw err;
  }
}

// =====================================================
// Notes (extended)
// =====================================================

export async function getNoteOnContact(
  client: GHLClient,
  contactId: string,
  noteId: string,
): Promise<{ note?: { id: string; body: string; userId?: string; dateAdded?: string } }> {
  return client.get<{ note?: { id: string; body: string; userId?: string; dateAdded?: string } }>(
    `/contacts/${contactId}/notes/${noteId}`,
  );
}

export async function updateNoteOnContact(
  client: GHLClient,
  contactId: string,
  noteId: string,
  body: string,
): Promise<void> {
  await client.put(`/contacts/${contactId}/notes/${noteId}`, { body });
}

export async function deleteNoteOnContact(
  client: GHLClient,
  contactId: string,
  noteId: string,
): Promise<void> {
  await client.delete(`/contacts/${contactId}/notes/${noteId}`);
}

export async function listNotesOnContact(
  client: GHLClient,
  contactId: string,
): Promise<{ notes?: Array<{ id: string; body: string; userId?: string; dateAdded?: string }> }> {
  return client.get<{ notes?: Array<{ id: string; body: string; userId?: string; dateAdded?: string }> }>(
    `/contacts/${contactId}/notes`,
  );
}

// =====================================================
// Tasks
// =====================================================

export async function createTaskOnContact(
  client: GHLClient,
  contactId: string,
  payload: {
    title: string;
    body?: string;
    dueDate: string;
    completed: boolean;
    assignedTo?: string;
  },
): Promise<{ id?: string }> {
  return client.post<{ id?: string }>(`/contacts/${contactId}/tasks`, payload);
}

export async function getTaskOnContact(
  client: GHLClient,
  contactId: string,
  taskId: string,
): Promise<{
  task?: { id: string; title: string; body?: string; completed: boolean; dueDate: string; assignedTo?: string };
}> {
  return client.get<{
    task?: { id: string; title: string; body?: string; completed: boolean; dueDate: string; assignedTo?: string };
  }>(`/contacts/${contactId}/tasks/${taskId}`);
}

export async function updateTaskOnContact(
  client: GHLClient,
  contactId: string,
  taskId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await client.put(`/contacts/${contactId}/tasks/${taskId}`, body);
}

export async function completeTaskOnContact(
  client: GHLClient,
  contactId: string,
  taskId: string,
  completed: boolean,
): Promise<void> {
  await client.put(`/contacts/${contactId}/tasks/${taskId}/completed`, { completed });
}

export async function deleteTaskOnContact(
  client: GHLClient,
  contactId: string,
  taskId: string,
): Promise<void> {
  await client.delete(`/contacts/${contactId}/tasks/${taskId}`);
}

export async function listTasksOnContact(
  client: GHLClient,
  contactId: string,
): Promise<{
  tasks?: Array<{ id: string; title: string; body?: string; completed: boolean; dueDate: string; assignedTo?: string }>;
}> {
  return client.get<{
    tasks?: Array<{ id: string; title: string; body?: string; completed: boolean; dueDate: string; assignedTo?: string }>;
  }>(`/contacts/${contactId}/tasks`);
}

export interface GhlSearchedTask {
  // ATENÇÃO: a busca por location retorna o id como `_id` (o webhook usa `id`).
  _id?: string;
  id?: string;
  title?: string;
  body?: string;
  completed?: boolean;
  dueDate?: string;
  assignedTo?: string;
  contactId?: string;
  locationId?: string;
}

/**
 * Busca tasks por LOCATION (POST /locations/{id}/tasks/search). Usada pelo
 * backfill de lembretes de tarefa (FORGE-3 2026-05-21) — o webhook só cobre
 * tasks NOVAS/editadas, então pra cobrir as ANTIGAS a gente varre aqui.
 * Filtra por `completed` (pendentes) + paginação; o filtro de due date é
 * client-side (a API não tem). Pode 403 se o app GHL não tiver o escopo de task.
 */
export async function searchLocationTasks(
  client: GHLClient,
  locationId: string,
  body: { completed?: boolean; assignedTo?: string[]; contactId?: string[]; limit?: number; skip?: number },
): Promise<{ tasks?: GhlSearchedTask[] }> {
  return client.post<{ tasks?: GhlSearchedTask[] }>(`/locations/${locationId}/tasks/search`, body);
}

// =====================================================
// Contacts CRUD
// =====================================================

export async function searchContactsList(
  client: GHLClient,
  locationId: string,
  query: string,
  limit: number,
): Promise<{ contacts?: Array<Record<string, unknown>> }> {
  return client.get<{ contacts?: Array<Record<string, unknown>> }>("/contacts/", {
    locationId,
    query,
    limit: String(limit),
  });
}

export async function getContact(
  client: GHLClient,
  contactId: string,
): Promise<{ contact: Record<string, unknown> }> {
  return client.get<{ contact: Record<string, unknown> }>(`/contacts/${contactId}`);
}

export async function createContact(
  client: GHLClient,
  body: Record<string, unknown>,
): Promise<{ contact?: { id: string } }> {
  return client.post<{ contact?: { id: string } }>("/contacts/", body);
}

export async function updateContact(
  client: GHLClient,
  contactId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await client.put(`/contacts/${contactId}`, body);
}

export async function deleteContact(
  client: GHLClient,
  contactId: string,
): Promise<void> {
  await client.delete(`/contacts/${contactId}`);
}

export async function getContactAppointments(
  client: GHLClient,
  contactId: string,
): Promise<{
  events?: Array<{
    id: string; title?: string; startTime: string; endTime: string;
    appointmentStatus?: string; assignedUserId?: string; calendarId?: string;
  }>;
}> {
  return client.get<{
    events?: Array<{
      id: string; title?: string; startTime: string; endTime: string;
      appointmentStatus?: string; assignedUserId?: string; calendarId?: string;
    }>;
  }>(`/contacts/${contactId}/appointments`);
}

export async function upsertContact(
  client: GHLClient,
  payload: Record<string, unknown>,
): Promise<{ contact?: { id: string } }> {
  return client.post<{ contact?: { id: string } }>("/contacts/upsert", payload);
}

export async function postNoteOnContactRaw(
  client: GHLClient,
  contactId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await client.post(`/contacts/${contactId}/notes`, body);
}

// =====================================================
// Metadata (location-level)
// =====================================================

export async function listLocationCustomFields(
  client: GHLClient,
  locationId: string,
): Promise<{
  customFields?: Array<{ id: string; name?: string; fieldKey?: string; dataType?: string; placeholder?: string; position?: number }>;
}> {
  return client.get<{
    customFields?: Array<{ id: string; name?: string; fieldKey?: string; dataType?: string; placeholder?: string; position?: number }>;
  }>(`/locations/${locationId}/customFields`);
}

export async function listLocationTags(
  client: GHLClient,
  locationId: string,
): Promise<{ tags?: Array<{ id?: string; name: string }> }> {
  return client.get<{ tags?: Array<{ id?: string; name: string }> }>(
    `/locations/${locationId}/tags`,
  );
}

export async function listLocationUsers(
  client: GHLClient,
  locationId: string,
): Promise<{
  users?: Array<{
    id: string; firstName?: string; lastName?: string; name?: string;
    email?: string; phone?: string; roles?: { role?: string };
  }>;
}> {
  return client.get<{
    users?: Array<{
      id: string; firstName?: string; lastName?: string; name?: string;
      email?: string; phone?: string; roles?: { role?: string };
    }>;
  }>("/users/", { locationId });
}

// =====================================================
// Opportunities
// =====================================================

export async function getPipelines(
  client: GHLClient,
  locationId: string,
): Promise<{
  pipelines?: Array<{
    id: string; name?: string;
    stages?: Array<{ id: string; name?: string; position?: number }>;
  }>;
}> {
  return client.get<{
    pipelines?: Array<{
      id: string; name?: string;
      stages?: Array<{ id: string; name?: string; position?: number }>;
    }>;
  }>("/opportunities/pipelines", { locationId });
}

export async function searchOpportunities(
  client: GHLClient,
  params: Record<string, string>,
): Promise<{
  opportunities?: Array<Record<string, unknown>>;
  meta?: { total?: number; startAfterId?: string; startAfter?: number; nextPageUrl?: string };
}> {
  return client.get<{
    opportunities?: Array<Record<string, unknown>>;
    meta?: { total?: number; startAfterId?: string; startAfter?: number; nextPageUrl?: string };
  }>("/opportunities/search", params);
}

export async function getOpportunity(
  client: GHLClient,
  oppId: string,
): Promise<{
  opportunity?: {
    id: string; name?: string; monetaryValue?: number;
    status?: string; pipelineId?: string; pipelineStageId?: string;
    contactId?: string; assignedTo?: string;
    source?: string; lastStatusChangeAt?: string; lastStageChangeAt?: string;
    updatedAt?: string; createdAt?: string;
  };
}> {
  return client.get<{
    opportunity?: {
      id: string; name?: string; monetaryValue?: number;
      status?: string; pipelineId?: string; pipelineStageId?: string;
      contactId?: string; assignedTo?: string;
      source?: string; lastStatusChangeAt?: string; lastStageChangeAt?: string;
      updatedAt?: string; createdAt?: string;
    };
  }>(`/opportunities/${oppId}`);
}

export async function createOpportunity(
  client: GHLClient,
  body: Record<string, unknown>,
): Promise<{ opportunity?: { id: string } }> {
  return client.post<{ opportunity?: { id: string } }>("/opportunities/", body);
}

export async function updateOpportunity(
  client: GHLClient,
  oppId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await client.put(`/opportunities/${oppId}`, body);
}

export async function updateOpportunityStatus(
  client: GHLClient,
  oppId: string,
  status: string,
): Promise<void> {
  await client.put(`/opportunities/${oppId}/status`, { status });
}

export async function deleteOpportunity(
  client: GHLClient,
  oppId: string,
): Promise<void> {
  await client.delete(`/opportunities/${oppId}`);
}

// =====================================================
// Calendar
// =====================================================

export async function listCalendars(
  client: GHLClient,
  locationId: string,
): Promise<{
  calendars?: Array<{
    id: string; name?: string; description?: string; widgetSlug?: string;
    slotDuration?: number; slotDurationUnit?: string;
    openHours?: Array<{
      daysOfTheWeek: number[];
      hours: Array<{ openHour: number; openMinute: number; closeHour: number; closeMinute: number }>;
    }>;
    teamMembers?: Array<{ userId: string; selected?: boolean }>;
  }>;
}> {
  return client.get<{
    calendars?: Array<{
      id: string; name?: string; description?: string; widgetSlug?: string;
      slotDuration?: number; slotDurationUnit?: string;
      openHours?: Array<{
        daysOfTheWeek: number[];
        hours: Array<{ openHour: number; openMinute: number; closeHour: number; closeMinute: number }>;
      }>;
      teamMembers?: Array<{ userId: string; selected?: boolean }>;
    }>;
  }>("/calendars/", { locationId });
}

export async function getCalendarFreeSlots(
  client: GHLClient,
  calendarId: string,
  params: Record<string, string>,
): Promise<Record<string, { slots?: string[] }>> {
  return client.get<Record<string, { slots?: string[] }>>(
    `/calendars/${encodeURIComponent(calendarId)}/free-slots`,
    params,
  );
}

export async function listCalendarEvents(
  client: GHLClient,
  params: Record<string, string>,
): Promise<{
  events?: Array<{
    id: string; title?: string; startTime: string; endTime: string;
    contactId?: string; appointmentStatus?: string; assignedUserId?: string; calendarId?: string;
  }>;
}> {
  return client.get<{
    events?: Array<{
      id: string; title?: string; startTime: string; endTime: string;
      contactId?: string; appointmentStatus?: string; assignedUserId?: string; calendarId?: string;
    }>;
  }>("/calendars/events", params);
}

export async function getAppointment(
  client: GHLClient,
  appointmentId: string,
): Promise<{
  appointment?: {
    id: string; title?: string; startTime?: string; endTime?: string;
    contactId?: string; appointmentStatus?: string;
    assignedUserId?: string; calendarId?: string;
    address?: string; meetingLocationType?: string;
    notes?: string; createdAt?: string; updatedAt?: string;
  };
}> {
  return client.get<{
    appointment?: {
      id: string; title?: string; startTime?: string; endTime?: string;
      contactId?: string; appointmentStatus?: string;
      assignedUserId?: string; calendarId?: string;
      address?: string; meetingLocationType?: string;
      notes?: string; createdAt?: string; updatedAt?: string;
    };
  }>(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`);
}

export async function createAppointment(
  client: GHLClient,
  body: Record<string, unknown>,
): Promise<{ id?: string; appointment?: { id: string }; assignedUserId?: string }> {
  return client.post<{ id?: string; appointment?: { id: string }; assignedUserId?: string }>(
    "/calendars/events/appointments",
    body,
  );
}

export async function createBlockSlot(
  client: GHLClient,
  body: Record<string, unknown>,
): Promise<{ id?: string; event?: { id: string } }> {
  return client.post<{ id?: string; event?: { id: string } }>(
    "/calendars/events/block-slots",
    body,
  );
}

export async function updateAppointment(
  client: GHLClient,
  appointmentId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await client.put(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, body);
}

export async function deleteAppointment(
  client: GHLClient,
  appointmentId: string,
): Promise<void> {
  await client.delete(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`);
}

export async function getCalendarDetails(
  client: GHLClient,
  calendarId: string,
): Promise<{ calendar?: { teamMembers?: Array<{ userId?: string; isPrimary?: boolean }> } }> {
  return client.get<{ calendar?: { teamMembers?: Array<{ userId?: string; isPrimary?: boolean }> } }>(
    `/calendars/${encodeURIComponent(calendarId)}`,
  );
}

// =====================================================
// Conversations
// =====================================================

export async function searchConversationsList(
  client: GHLClient,
  locationId: string,
  contactId: string,
): Promise<{
  conversations?: Array<{
    id: string; contactId: string; lastMessageDate?: string;
    unreadCount?: number; type?: string;
  }>;
}> {
  return client.get<{
    conversations?: Array<{
      id: string; contactId: string; lastMessageDate?: string;
      unreadCount?: number; type?: string;
    }>;
  }>("/conversations/search", { locationId, contactId });
}

export async function getConversationMessages(
  client: GHLClient,
  conversationId: string,
  locationId: string,
  limit: number,
): Promise<{
  messages?: {
    messages?: Array<{
      id: string; direction: string; body?: string; messageType?: string;
      dateAdded: string; status?: string; userId?: string;
    }>;
  };
}> {
  return client.get<{
    messages?: {
      messages?: Array<{
        id: string; direction: string; body?: string; messageType?: string;
        dateAdded: string; status?: string; userId?: string;
      }>;
    };
  }>(`/conversations/${conversationId}/messages`, {
    locationId,
    limit: String(limit),
  });
}

export async function postConversationMessage(
  client: GHLClient,
  body: Record<string, unknown>,
): Promise<{ messageId?: string; conversationId?: string }> {
  return client.post<{ messageId?: string; conversationId?: string }>(
    "/conversations/messages",
    body,
  );
}

// =====================================================
// Messages (conversations)
// =====================================================

export type GhlChannel = "SMS" | "WhatsApp" | "Email" | "IG";

export async function sendMessageToContact(
  client: GHLClient,
  contactId: string,
  message: string,
  channel: GhlChannel = "SMS",
  options?: { conversationId?: string; subject?: string },
): Promise<{ messageId?: string; conversationId?: string }> {
  const body: Record<string, unknown> = {
    type: channel,
    contactId,
    message,
    ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
    ...(channel === "Email" && options?.subject ? { subject: options.subject } : {}),
  };
  return client.post<{ messageId?: string; conversationId?: string }>(
    "/conversations/messages",
    body,
  );
}

// =====================================================
// Booking error detection (centralizada)
// =====================================================

// Fix HIGH-11 (deep review 2026-05-05): keyword "calendar"/"calendario"
// era genérica demais — erro de CONFIG ("Calendario nao configurado") batia
// como conflict, action-executor mandava "tenta outro horário" ao lead em
// loop infinito. Agora keywords são específicas de CONFLICT (slot ocupado/
// já agendado/etc) E filtramos keywords de CONFIG (não configurado/missing).
const BOOKING_CONFLICT_KEYWORDS = [
  "no longer available", "no longer", "not available",
  "slot is",                           // "slot is not available" / "slot is taken"
  "conflict", "busy", "occupied",
  "ja agendado", "já agendado",
  "horario indisponivel", "horário indisponível",
  "422",                               // GHL 422 typical pra slot conflict
];

const BOOKING_CONFIG_KEYWORDS = [
  "nao configurado", "não configurado",
  "not configured", "missing calendar",
  "calendarid required",
];

/**
 * Detecta se um erro do GHL parece ser de slot ocupado / conflict de
 * agendamento. Usado pelo action-executor pra decidir se reagenda em
 * outro horário ou trata como erro genérico.
 *
 * IMPORTANTE: erro de CONFIG (calendar não configurado, missing ID) NÃO é
 * conflict — bot não deve oferecer "outro horário". Filtramos antes.
 */
export function isBookingConflictError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Se é erro de config, NÃO é conflict
  if (BOOKING_CONFIG_KEYWORDS.some((k) => msg.includes(k))) return false;
  return BOOKING_CONFLICT_KEYWORDS.some((k) => msg.includes(k));
}
