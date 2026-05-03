/**
 * Tools de Contatos. CRUD + busca + acessórios (notes/tasks/appointments do contato).
 */

import type { ToolEntry } from "./types";
import { validateGhlId, ghlErrorToResult } from "./types";

const searchContacts: ToolEntry = {
  def: {
    name: "search_contacts",
    description:
      "Busca contatos (leads/clientes) por nome, email ou telefone. Retorna até 20 resultados com id real do GHL. Use SEMPRE antes de qualquer ação que precise de contact_id.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nome, email ou telefone." },
        limit: { type: "number", description: "Máximo de resultados (default 10, max 20).", default: 10 },
      },
      required: ["query"],
    },
  },
  handler: async (ctx, args) => {
    const query = String(args.query || "").trim();
    const limit = Math.min(Number(args.limit) || 10, 20);
    if (!query) return { status: "error", message: "query obrigatória", retryable: false };

    try {
      const res = await ctx.ghlClient.get<{
        contacts?: Array<{
          id: string;
          firstName?: string; lastName?: string; name?: string;
          email?: string; phone?: string;
          lastActivity?: string; tags?: string[];
        }>;
      }>("/contacts/", { locationId: ctx.locationId, query, limit: String(limit) });

      const contacts = (res.contacts || []).slice(0, limit);
      if (contacts.length === 0) {
        return { status: "not_found", message: `Nenhum contato encontrado pra "${query}"` };
      }
      return {
        status: "ok",
        data: contacts.map((c) => ({
          id: c.id,
          name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "(sem nome)",
          email: c.email || null,
          phone: c.phone || null,
          tags: c.tags || [],
          last_activity: c.lastActivity || null,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "busca de contatos");
    }
  },
};

const getContact: ToolEntry = {
  def: {
    name: "get_contact",
    description: "Detalhes completos de um contato (tags, custom fields, datas).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        contact: {
          id: string;
          firstName?: string; lastName?: string; name?: string;
          email?: string; phone?: string; tags?: string[];
          customFields?: Array<{ id: string; value: string; fieldKey?: string }>;
          dateAdded?: string; lastActivity?: string;
          address1?: string; city?: string; state?: string; postalCode?: string; country?: string;
          companyName?: string; dateOfBirth?: string;
        };
      }>(`/contacts/${contactId}`);

      if (!res.contact) return { status: "not_found", message: `Contato ${contactId} não existe` };
      const c = res.contact;
      return {
        status: "ok",
        data: {
          id: c.id,
          name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
          email: c.email,
          phone: c.phone,
          tags: c.tags || [],
          address: { line1: c.address1, city: c.city, state: c.state, postalCode: c.postalCode, country: c.country },
          company: c.companyName,
          date_of_birth: c.dateOfBirth,
          custom_fields: (c.customFields || []).map((f) => ({ key: f.fieldKey || f.id, value: f.value })),
          created_at: c.dateAdded,
          last_activity: c.lastActivity,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de contato");
    }
  },
};

const createContact: ToolEntry = {
  def: {
    name: "create_contact",
    description:
      "Cria contato novo na location ativa. GHL faz dedup automático por email/phone. Use quando o rep pedir 'cria um novo lead/cliente'.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string", description: "Email do contato (recomendado)." },
        phone: { type: "string", description: "Phone E.164 (ex: +5511987654321)." },
        company_name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "string", description: "Onde o lead veio (ex: 'WhatsApp inbound')." },
        assigned_to: {
          type: "string",
          description:
            "GHL user ID do dono/owner. Se o rep pedir 'me coloca como owner', " +
            "use o ghl_user_id dele na location ativa.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const firstName = args.first_name ? String(args.first_name).trim() : undefined;
    const lastName = args.last_name ? String(args.last_name).trim() : undefined;
    const email = args.email ? String(args.email).trim() : undefined;
    const phone = args.phone ? String(args.phone).trim() : undefined;
    if (!firstName && !lastName && !email && !phone) {
      return { status: "error", message: "Pelo menos um de: first_name, last_name, email, phone", retryable: false };
    }

    try {
      const body: Record<string, unknown> = { locationId: ctx.locationId };
      if (firstName) body.firstName = firstName;
      if (lastName) body.lastName = lastName;
      if (email) body.email = email;
      if (phone) body.phone = phone;
      if (args.company_name) body.companyName = String(args.company_name);
      if (Array.isArray(args.tags)) body.tags = args.tags;
      if (args.source) body.source = String(args.source);
      if (args.assigned_to) body.assignedTo = String(args.assigned_to);

      const res = await ctx.ghlClient.post<{ contact?: { id: string } }>("/contacts/", body);
      return { status: "ok", data: { contact_id: res.contact?.id } };
    } catch (err) {
      return ghlErrorToResult(err, "criação de contato");
    }
  },
};

const updateContact: ToolEntry = {
  def: {
    name: "update_contact",
    description:
      "Atualiza um ou mais campos do contato. Aceita standard fields (firstName, lastName, email, phone, address1, city, state, postalCode, country, companyName, dateOfBirth), owner via assigned_to (GHL user ID), ou custom fields via custom_fields[].",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        company_name: { type: "string" },
        address: {
          type: "object",
          properties: {
            line1: { type: "string" }, city: { type: "string" }, state: { type: "string" },
            postal_code: { type: "string" }, country: { type: "string" },
          },
        },
        date_of_birth: { type: "string", description: "ISO date YYYY-MM-DD" },
        assigned_to: {
          type: "string",
          description:
            "GHL user ID do dono/owner do contato (campo `assignedTo` na API GHL). " +
            "Se o rep pedir 'me coloca como owner', use ctx.rep.ghl_users[active].ghl_user_id.",
        },
        custom_fields: {
          type: "array",
          description: "[{ key: 'field_id_or_key', value: '...' }]",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
      },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    const body: Record<string, unknown> = {};
    if (args.first_name) body.firstName = String(args.first_name);
    if (args.last_name) body.lastName = String(args.last_name);
    if (args.email) body.email = String(args.email);
    if (args.phone) body.phone = String(args.phone);
    if (args.company_name) body.companyName = String(args.company_name);
    if (args.date_of_birth) body.dateOfBirth = String(args.date_of_birth);
    if (args.assigned_to) body.assignedTo = String(args.assigned_to);
    if (args.address && typeof args.address === "object") {
      const a = args.address as Record<string, unknown>;
      if (a.line1) body.address1 = String(a.line1);
      if (a.city) body.city = String(a.city);
      if (a.state) body.state = String(a.state);
      if (a.postal_code) body.postalCode = String(a.postal_code);
      if (a.country) body.country = String(a.country);
    }
    if (Array.isArray(args.custom_fields)) {
      // Fix CRITICAL stress test 2026-05-03: GHL aceita { id: UUID } OU
      // { key: slug } — antes hardcodávamos `id: cf.key` e custom fields
      // referenciados por slug (vindo de list_custom_fields) eram silenciosamente
      // descartados pelo GHL. Agora detecta formato e mapeia correto.
      // GHL IDs são alfanuméricos ~20+ chars. Slugs costumam ter underscore ou
      // chars não-alfanuméricos.
      body.customFields = (args.custom_fields as Array<{ key: string; value: string }>).map(
        (cf) => {
          const looksLikeGhlId = /^[A-Za-z0-9]{18,}$/.test(cf.key);
          return looksLikeGhlId
            ? { id: cf.key, value: cf.value }
            : { key: cf.key, value: cf.value };
        },
      );
    }
    if (Object.keys(body).length === 0) {
      return { status: "error", message: "Nenhum campo pra atualizar", retryable: false };
    }

    try {
      await ctx.ghlClient.put(`/contacts/${contactId}`, body);
      return { status: "ok", data: { updated: Object.keys(body) } };
    } catch (err) {
      return ghlErrorToResult(err, "atualização de contato");
    }
  },
};

const deleteContact: ToolEntry = {
  def: {
    name: "delete_contact",
    description:
      "⚠️ AÇÃO IRREVERSÍVEL: Apaga o contato e TODOS os dados associados (notas, tasks, appointments, oportunidades). Use só com confirmação explícita do rep.",
    risk: "high",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      await ctx.ghlClient.delete(`/contacts/${contactId}`);
      return { status: "ok", data: { deleted: contactId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de contato");
    }
  },
};

const getContactNotes: ToolEntry = {
  def: {
    name: "get_contact_notes",
    description: "Lista todas as notas de um contato, mais recentes primeiro.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        notes?: Array<{ id: string; body: string; userId?: string; dateAdded?: string }>;
      }>(`/contacts/${contactId}/notes`);
      const notes = (res.notes || []).slice(0, 30);
      return {
        status: "ok",
        data: notes.map((n) => ({
          id: n.id,
          body: n.body,
          author_id: n.userId,
          created_at: n.dateAdded,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de notas");
    }
  },
};

const getContactTasks: ToolEntry = {
  def: {
    name: "get_contact_tasks",
    description: "Lista todas as tasks (pendentes e completas) de um contato.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        tasks?: Array<{
          id: string; title: string; body?: string;
          completed: boolean; dueDate: string;
          assignedTo?: string;
        }>;
      }>(`/contacts/${contactId}/tasks`);
      return {
        status: "ok",
        data: (res.tasks || []).map((t) => ({
          id: t.id,
          title: t.title,
          body: t.body,
          completed: t.completed,
          due_at: t.dueDate,
          assigned_to: t.assignedTo,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de tasks");
    }
  },
};

const getContactAppointments: ToolEntry = {
  def: {
    name: "get_contact_appointments",
    description: "Lista appointments associados a um contato (passados e futuros).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        events?: Array<{
          id: string; title?: string; startTime: string; endTime: string;
          appointmentStatus?: string; assignedUserId?: string; calendarId?: string;
        }>;
      }>(`/contacts/${contactId}/appointments`);
      return {
        status: "ok",
        data: (res.events || []).map((e) => ({
          id: e.id, title: e.title || "(sem título)",
          start: e.startTime, end: e.endTime,
          status: e.appointmentStatus || "scheduled",
          assigned_to: e.assignedUserId,
          calendar_id: e.calendarId,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de appointments do contato");
    }
  },
};

export const CONTACTS_TOOLS: ToolEntry[] = [
  searchContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  getContactNotes,
  getContactTasks,
  getContactAppointments,
];
