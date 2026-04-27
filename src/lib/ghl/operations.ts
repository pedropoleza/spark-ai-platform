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

const BOOKING_CONFLICT_KEYWORDS = [
  "available", "conflict", "calendario", "calendário", "calendar",
  "slot", "agendamento", "busy", "occupied", "no longer", "ja agendado",
  "já agendado", "422",
];

/**
 * Detecta se um erro do GHL parece ser de slot ocupado / conflict de
 * agendamento. Usado pelo action-executor pra decidir se reagenda em
 * outro horário ou trata como erro genérico.
 */
export function isBookingConflictError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return BOOKING_CONFLICT_KEYWORDS.some((k) => msg.includes(k));
}
