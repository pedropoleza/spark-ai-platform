/**
 * Catálogo de tools do Sparkbot V1. Cada tool tem:
 *   - Definition (nome, descrição, schema de args em JSON Schema)
 *   - Risk level (safe/medium/high)
 *   - Handler (executa usando GHLClient no contexto da location do rep)
 *
 * Tools safe executam direto. Medium executam + confirmam "feito X".
 * High (não tem em V1) exige confirmação explícita antes.
 */

import { GHLClient } from "@/lib/ghl/client";
import type { ToolDefinition, ToolResult, RepIdentity } from "@/types/account-assistant";

export interface ToolContext {
  rep: RepIdentity;
  locationId: string;  // active_location_id resolvido
  companyId: string;
  ghlClient: GHLClient;
}

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;

// =====================================================
// 1. search_contacts (safe)
// =====================================================
const searchContacts: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "search_contacts",
    description:
      "Busca contatos (leads/clientes do rep) por nome, email ou telefone. Retorna até 10 resultados. Use quando o rep mencionar alguém por nome.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nome, email ou telefone para buscar." },
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
          firstName?: string;
          lastName?: string;
          name?: string;
          email?: string;
          phone?: string;
          lastActivity?: string;
          tags?: string[];
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
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro buscando contatos",
        retryable: true,
      };
    }
  },
};

// =====================================================
// 2. get_contact (safe)
// =====================================================
const getContact: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "get_contact",
    description:
      "Retorna detalhes completos de um contato (tags, custom fields, histórico recente). Use quando o rep pedir info específica de alguém já identificado.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "ID do contato no GHL." },
      },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    if (!contactId) return { status: "error", message: "contact_id obrigatório", retryable: false };

    try {
      const res = await ctx.ghlClient.get<{
        contact: {
          id: string;
          firstName?: string;
          lastName?: string;
          name?: string;
          email?: string;
          phone?: string;
          tags?: string[];
          customFields?: Array<{ id: string; value: string; fieldKey?: string }>;
          dateAdded?: string;
          lastActivity?: string;
        };
      }>(`/contacts/${contactId}`);

      if (!res.contact) {
        return { status: "not_found", message: `Contato ${contactId} não existe` };
      }
      const c = res.contact;
      return {
        status: "ok",
        data: {
          id: c.id,
          name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
          email: c.email,
          phone: c.phone,
          tags: c.tags || [],
          custom_fields: (c.customFields || []).map((f) => ({
            key: f.fieldKey || f.id,
            value: f.value,
          })),
          created_at: c.dateAdded,
          last_activity: c.lastActivity,
        },
      };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro buscando contato",
        retryable: true,
      };
    }
  },
};

// =====================================================
// 3. list_appointments (safe)
// =====================================================
const listAppointments: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "list_appointments",
    description:
      'Lista appointments do rep (default só os dele). Use quando o rep perguntar "quais minhas reuniões hoje/essa semana".',
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        when: {
          type: "string",
          enum: ["today", "week", "tomorrow"],
          description: "Janela de tempo.",
        },
      },
      required: ["when"],
    },
  },
  handler: async (ctx, args) => {
    const when = String(args.when || "today");
    const now = new Date();
    let startTs: number, endTs: number;

    if (when === "today") {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      startTs = start.getTime(); endTs = end.getTime();
    } else if (when === "tomorrow") {
      const start = new Date(now); start.setDate(start.getDate() + 1); start.setHours(0, 0, 0, 0);
      const end = new Date(start); end.setHours(23, 59, 59, 999);
      startTs = start.getTime(); endTs = end.getTime();
    } else {
      // week: próximos 7 dias
      startTs = now.getTime();
      const end = new Date(now); end.setDate(end.getDate() + 7);
      endTs = end.getTime();
    }

    const repGhlUserId = ctx.rep.ghl_users.find((u) => u.location_id === ctx.locationId)?.ghl_user_id;

    try {
      const res = await ctx.ghlClient.get<{
        events?: Array<{
          id: string;
          title?: string;
          startTime: string;
          endTime: string;
          contactId?: string;
          appointmentStatus?: string;
          assignedUserId?: string;
        }>;
      }>("/calendars/events", {
        locationId: ctx.locationId,
        startTime: String(startTs),
        endTime: String(endTs),
        ...(repGhlUserId ? { userId: repGhlUserId } : {}),
      });

      const events = res.events || [];
      return {
        status: "ok",
        data: events.map((e) => ({
          id: e.id,
          title: e.title || "(sem título)",
          start: e.startTime,
          end: e.endTime,
          contact_id: e.contactId || null,
          status: e.appointmentStatus || "scheduled",
        })),
      };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro buscando appointments",
        retryable: true,
      };
    }
  },
};

// =====================================================
// 4. list_opportunities (safe)
// =====================================================
const listOpportunities: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "list_opportunities",
    description:
      "Lista opportunities abertas do rep, opcionalmente filtradas por pipeline ou valor mínimo.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "won", "lost", "all"], default: "open" },
        min_value: { type: "number", description: "Valor monetário mínimo." },
        pipeline_id: { type: "string" },
      },
    },
  },
  handler: async (ctx, args) => {
    const status = String(args.status || "open");
    const minValue = typeof args.min_value === "number" ? args.min_value : 0;
    const pipelineId = args.pipeline_id ? String(args.pipeline_id) : undefined;
    const repGhlUserId = ctx.rep.ghl_users.find((u) => u.location_id === ctx.locationId)?.ghl_user_id;

    try {
      const params: Record<string, string> = {
        location_id: ctx.locationId,
        ...(status !== "all" ? { status } : {}),
        ...(pipelineId ? { pipeline_id: pipelineId } : {}),
        ...(repGhlUserId ? { assigned_to: repGhlUserId } : {}),
      };

      const res = await ctx.ghlClient.get<{
        opportunities?: Array<{
          id: string;
          name?: string;
          monetaryValue?: number;
          status?: string;
          pipelineId?: string;
          pipelineStageId?: string;
          contactId?: string;
          assignedTo?: string;
          updatedAt?: string;
        }>;
      }>("/opportunities/search", params);

      const opps = (res.opportunities || []).filter(
        (o) => (o.monetaryValue || 0) >= minValue,
      );
      return {
        status: "ok",
        data: opps.map((o) => ({
          id: o.id,
          name: o.name,
          value: o.monetaryValue || 0,
          status: o.status,
          pipeline_id: o.pipelineId,
          stage_id: o.pipelineStageId,
          contact_id: o.contactId,
          updated_at: o.updatedAt,
        })),
      };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro buscando opportunities",
        retryable: true,
      };
    }
  },
};

// =====================================================
// 5. create_note (medium)
// =====================================================
const createNote: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "create_note",
    description: "Cria uma nota no contato. Use quando o rep pedir 'adiciona nota no X'.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        body: { type: "string", description: "Conteúdo da nota." },
      },
      required: ["contact_id", "body"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const body = String(args.body || "").trim();
    if (!contactId || !body) {
      return { status: "error", message: "contact_id e body obrigatórios", retryable: false };
    }

    try {
      const res = await ctx.ghlClient.post<{ id?: string; note?: { id: string } }>(
        `/contacts/${contactId}/notes`,
        { body },
      );
      const noteId = res.id || res.note?.id;
      return { status: "ok", data: { note_id: noteId } };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro criando nota",
        retryable: true,
      };
    }
  },
};

// =====================================================
// 6. create_task (medium)
// =====================================================
const createTask: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "create_task",
    description: "Cria uma task associada ao contato, com data de vencimento.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        title: { type: "string" },
        due_at: { type: "string", description: "ISO timestamp ou data natural (converter pra ISO antes)." },
        body: { type: "string", description: "Descrição opcional." },
      },
      required: ["contact_id", "title", "due_at"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const title = String(args.title || "").trim();
    const dueAt = String(args.due_at || "");
    const body = args.body ? String(args.body) : undefined;
    if (!contactId || !title || !dueAt) {
      return { status: "error", message: "contact_id, title e due_at obrigatórios", retryable: false };
    }
    const repGhlUserId = ctx.rep.ghl_users.find((u) => u.location_id === ctx.locationId)?.ghl_user_id;

    try {
      const res = await ctx.ghlClient.post<{ id?: string }>(`/contacts/${contactId}/tasks`, {
        title,
        body,
        dueDate: dueAt,
        ...(repGhlUserId ? { assignedTo: repGhlUserId } : {}),
      });
      return { status: "ok", data: { task_id: res.id } };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro criando task",
        retryable: true,
      };
    }
  },
};

// =====================================================
// 7. modify_tag (medium)
// =====================================================
const modifyTag: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "modify_tag",
    description: "Adiciona ou remove uma tag de um contato.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        tag: { type: "string" },
        action: { type: "string", enum: ["add", "remove"] },
      },
      required: ["contact_id", "tag", "action"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const tag = String(args.tag || "").trim();
    const action = String(args.action || "");
    if (!contactId || !tag || !["add", "remove"].includes(action)) {
      return { status: "error", message: "params inválidos", retryable: false };
    }

    try {
      if (action === "add") {
        await ctx.ghlClient.post(`/contacts/${contactId}/tags`, { tags: [tag] });
      } else {
        await ctx.ghlClient.delete(`/contacts/${contactId}/tags`, { tags: [tag] });
      }
      return { status: "ok", data: { tag, action } };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro modificando tag",
        retryable: true,
      };
    }
  },
};

// =====================================================
// 8. update_field (medium)
// =====================================================
const updateField: { def: ToolDefinition; handler: ToolHandler } = {
  def: {
    name: "update_field",
    description:
      "Atualiza um campo do contato. Aceita campos standard (firstName, email, phone, etc) ou custom field via key.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        field_key: { type: "string", description: "ex: 'firstName', 'email', 'custom_field_abc'" },
        value: { type: "string" },
      },
      required: ["contact_id", "field_key", "value"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const fieldKey = String(args.field_key || "").trim();
    const value = String(args.value || "");
    if (!contactId || !fieldKey) {
      return { status: "error", message: "contact_id e field_key obrigatórios", retryable: false };
    }

    // Distingue standard vs custom: campos standard são os nativos do GHL
    const STANDARD_FIELDS = new Set([
      "firstName", "lastName", "name", "email", "phone",
      "address1", "city", "state", "postalCode", "country",
      "companyName", "dateOfBirth", "timezone", "website",
    ]);

    try {
      const body: Record<string, unknown> = STANDARD_FIELDS.has(fieldKey)
        ? { [fieldKey]: value }
        : { customFields: [{ id: fieldKey, value }] };
      await ctx.ghlClient.put(`/contacts/${contactId}`, body);
      return { status: "ok", data: { field_key: fieldKey, value } };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Erro atualizando campo",
        retryable: true,
      };
    }
  },
};

// =====================================================
// Registry
// =====================================================
export const TOOL_REGISTRY: Record<string, { def: ToolDefinition; handler: ToolHandler }> = {
  search_contacts: searchContacts,
  get_contact: getContact,
  list_appointments: listAppointments,
  list_opportunities: listOpportunities,
  create_note: createNote,
  create_task: createTask,
  modify_tag: modifyTag,
  update_field: updateField,
};

/** Array de definitions pra passar pro LLM (Anthropic/OpenAI tools API). */
export function getAllToolDefinitions(): ToolDefinition[] {
  return Object.values(TOOL_REGISTRY).map((t) => t.def);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const entry = TOOL_REGISTRY[name];
  if (!entry) {
    return { status: "error", message: `Tool desconhecida: ${name}`, retryable: false };
  }
  return entry.handler(ctx, args);
}
