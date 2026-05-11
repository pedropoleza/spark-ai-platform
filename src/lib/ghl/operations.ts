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
 * Retorna {changed, previousAssignedTo} pra audit/log no caller.
 */
export async function ensureContactAssignedTo(
  client: GHLClient,
  contactId: string,
  targetUserId: string,
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
      // Já está com assignment correto
      return { changed: false, previousAssignedTo: current };
    }
    await client.put(`/contacts/${contactId}`, { assignedTo: targetUserId });
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
