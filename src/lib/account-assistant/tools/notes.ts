/**
 * Tools de Notas em contatos. CRUD individual.
 * (Listagem está em get_contact_notes em contacts.ts.)
 */

import type { ToolEntry } from "./types";
import { validateGhlId, ghlErrorToResult } from "./types";
import { createNoteOnContact } from "@/lib/ghl/operations";

const createNote: ToolEntry = {
  def: {
    name: "create_note",
    description: "Cria uma nota num contato. Use quando o rep pedir 'adiciona nota no X'.",
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
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const body = String(args.body || "").trim();
    if (!body) return { status: "error", message: "body obrigatório", retryable: false };

    try {
      const { noteId } = await createNoteOnContact(ctx.ghlClient, contactId, body);
      return { status: "ok", data: { note_id: noteId } };
    } catch (err) {
      return ghlErrorToResult(err, "criação de nota");
    }
  },
};

const getNote: ToolEntry = {
  def: {
    name: "get_note",
    description: "Retorna uma nota específica.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        note_id: { type: "string" },
      },
      required: ["contact_id", "note_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const noteId = String(args.note_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(noteId, "note");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        note?: { id: string; body: string; userId?: string; dateAdded?: string };
      }>(`/contacts/${contactId}/notes/${noteId}`);
      if (!res.note) return { status: "not_found", message: "Nota não encontrada" };
      return {
        status: "ok",
        data: {
          id: res.note.id,
          body: res.note.body,
          author_id: res.note.userId,
          created_at: res.note.dateAdded,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de nota");
    }
  },
};

const updateNote: ToolEntry = {
  def: {
    name: "update_note",
    description: "Edita o conteúdo de uma nota existente.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        note_id: { type: "string" },
        body: { type: "string", description: "Novo conteúdo." },
      },
      required: ["contact_id", "note_id", "body"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const noteId = String(args.note_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(noteId, "note");
    if (invalid) return invalid;
    const body = String(args.body || "").trim();
    if (!body) return { status: "error", message: "body obrigatório", retryable: false };

    try {
      await ctx.ghlClient.put(`/contacts/${contactId}/notes/${noteId}`, { body });
      return { status: "ok", data: { note_id: noteId } };
    } catch (err) {
      return ghlErrorToResult(err, "edição de nota");
    }
  },
};

const deleteNote: ToolEntry = {
  def: {
    name: "delete_note",
    description: "⚠️ AÇÃO IRREVERSÍVEL: Apaga a nota. Confirma antes de chamar.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        note_id: { type: "string" },
      },
      required: ["contact_id", "note_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const noteId = String(args.note_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(noteId, "note");
    if (invalid) return invalid;

    try {
      await ctx.ghlClient.delete(`/contacts/${contactId}/notes/${noteId}`);
      return { status: "ok", data: { deleted: noteId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de nota");
    }
  },
};

export const NOTES_TOOLS: ToolEntry[] = [createNote, getNote, updateNote, deleteNote];
