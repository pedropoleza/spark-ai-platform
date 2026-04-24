/**
 * Tools de Tasks em contatos. CRUD + dedicado pra marcar completed.
 *
 * GOTCHA: GHL exige `completed: false` no payload do create (descobrimos via
 * 422 em testes). Já tá no handler.
 */

import type { ToolEntry } from "./types";
import { validateGhlId, validateIso8601, getRepGhlUserId, ghlErrorToResult } from "./types";

const createTask: ToolEntry = {
  def: {
    name: "create_task",
    description:
      "Cria uma task associada ao contato. due_at DEVE ser ISO 8601 com timezone (ex: '2026-04-28T10:00:00-05:00'). Converta datas naturais ('amanhã 10h', 'segunda') usando o timezone do contexto antes de chamar.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        title: { type: "string" },
        due_at: { type: "string", description: "ISO 8601 com offset (ex: 2026-04-28T10:00:00-05:00) ou Z." },
        body: { type: "string", description: "Descrição opcional." },
      },
      required: ["contact_id", "title", "due_at"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const title = String(args.title || "").trim();
    if (!title) return { status: "error", message: "title obrigatório", retryable: false };
    const dueAt = String(args.due_at || "");
    const dateInvalid = validateIso8601(dueAt, "due_at");
    if (dateInvalid) return dateInvalid;
    const isoDueAt = new Date(dueAt).toISOString();

    try {
      const res = await ctx.ghlClient.post<{ id?: string }>(`/contacts/${contactId}/tasks`, {
        title,
        body: args.body ? String(args.body) : undefined,
        dueDate: isoDueAt,
        completed: false, // GHL exige campo explícito
        ...(getRepGhlUserId(ctx) ? { assignedTo: getRepGhlUserId(ctx) } : {}),
      });
      return { status: "ok", data: { task_id: res.id, due_at: isoDueAt } };
    } catch (err) {
      return ghlErrorToResult(err, "criação de task");
    }
  },
};

const getTask: ToolEntry = {
  def: {
    name: "get_task",
    description: "Retorna detalhes de uma task específica.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["contact_id", "task_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const taskId = String(args.task_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(taskId, "task");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        task?: {
          id: string; title: string; body?: string; completed: boolean;
          dueDate: string; assignedTo?: string;
        };
      }>(`/contacts/${contactId}/tasks/${taskId}`);
      if (!res.task) return { status: "not_found", message: "Task não encontrada" };
      return {
        status: "ok",
        data: {
          id: res.task.id,
          title: res.task.title,
          body: res.task.body,
          completed: res.task.completed,
          due_at: res.task.dueDate,
          assigned_to: res.task.assignedTo,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de task");
    }
  },
};

const updateTask: ToolEntry = {
  def: {
    name: "update_task",
    description: "Edita campos de uma task (título, body, due_at, assigned_to). Pra marcar completed use complete_task.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        task_id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        due_at: { type: "string", description: "ISO 8601" },
      },
      required: ["contact_id", "task_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const taskId = String(args.task_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(taskId, "task");
    if (invalid) return invalid;

    const body: Record<string, unknown> = {};
    if (args.title) body.title = String(args.title);
    if (args.body !== undefined) body.body = String(args.body);
    if (args.due_at) {
      const dateInvalid = validateIso8601(String(args.due_at), "due_at");
      if (dateInvalid) return dateInvalid;
      body.dueDate = new Date(String(args.due_at)).toISOString();
    }
    if (Object.keys(body).length === 0) {
      return { status: "error", message: "Nenhum campo pra atualizar", retryable: false };
    }

    try {
      await ctx.ghlClient.put(`/contacts/${contactId}/tasks/${taskId}`, body);
      return { status: "ok", data: { task_id: taskId, updated: Object.keys(body) } };
    } catch (err) {
      return ghlErrorToResult(err, "edição de task");
    }
  },
};

const completeTask: ToolEntry = {
  def: {
    name: "complete_task",
    description: "Marca uma task como completa (ou desmarca passando completed:false).",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        task_id: { type: "string" },
        completed: { type: "boolean", description: "true=marca completa, false=desmarca. Default: true." },
      },
      required: ["contact_id", "task_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const taskId = String(args.task_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(taskId, "task");
    if (invalid) return invalid;
    const completed = args.completed === false ? false : true;

    try {
      await ctx.ghlClient.put(`/contacts/${contactId}/tasks/${taskId}/completed`, { completed });
      return { status: "ok", data: { task_id: taskId, completed } };
    } catch (err) {
      return ghlErrorToResult(err, "marcação de task como completa");
    }
  },
};

const deleteTask: ToolEntry = {
  def: {
    name: "delete_task",
    description: "⚠️ AÇÃO IRREVERSÍVEL: Apaga a task.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        task_id: { type: "string" },
      },
      required: ["contact_id", "task_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const taskId = String(args.task_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(taskId, "task");
    if (invalid) return invalid;

    try {
      await ctx.ghlClient.delete(`/contacts/${contactId}/tasks/${taskId}`);
      return { status: "ok", data: { deleted: taskId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de task");
    }
  },
};

export const TASKS_TOOLS: ToolEntry[] = [createTask, getTask, updateTask, completeTask, deleteTask];
