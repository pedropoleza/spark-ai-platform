/**
 * Tools de Notas em contatos. CRUD individual.
 * (Listagem está em get_contact_notes em contacts.ts.)
 */

import type { ToolEntry } from "./types";
import { validateGhlId, ghlErrorToResult } from "./types";
import { createNoteOnContact, getNoteOnContact, updateNoteOnContact, deleteNoteOnContact } from "@/lib/ghl/operations";

const createNote: ToolEntry = {
  def: {
    name: "create_note",
    description:
      "Cria uma nota num contato. ⚠️ CHAME IMEDIATAMENTE quando rep:\n" +
      "  (a) pedir explícito 'anota', 'salva nos notes', 'coloca nas notas';\n" +
      "  (b) mandar 'vou te mandar info pra anotar em X' E em seguida mandar texto longo (objetivos, histórico, motivação do lead);\n" +
      "  (c) acabou de criar contato e logo após mandou texto descritivo sobre esse lead;\n" +
      "  (d) responder qualificação tipo '1- Por que...', '2- Como...'.\n\n" +
      "🚨 NUNCA responda 'Nota salva' / 'Anotei' / 'Coloquei nas notas' SEM ter chamado esta tool E recebido tool_result com status=ok. Bug CRÍTICO 2026-05-14 (Gustavo): bot mentiu 8 vezes seguidas afirmando 'Nota salva' sem chamar a tool. Não repetir.\n\n" +
      "🚨 MÚLTIPLAS NOTAS: cada texto longo = 1 chamada SEPARADA desta tool (não combine, não junte). " +
      "Se rep manda 5 mensagens com info, são 5 create_note distintas.\n\n" +
      "Pré-requisito: contact_id REAL obtido via search_contacts/create_contact no MESMO turn ou turn imediatamente anterior — nunca invente ID.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "ID alfanumérico ~20 chars do contato (de search_contacts/create_contact). NUNCA email/phone." },
        body: { type: "string", description: "Conteúdo COMPLETO da nota — preserve o texto exato que o rep mandou, sem resumir nem reescrever." },
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
      const res = await getNoteOnContact(ctx.ghlClient, contactId, noteId);
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
      await updateNoteOnContact(ctx.ghlClient, contactId, noteId, body);
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
      await deleteNoteOnContact(ctx.ghlClient, contactId, noteId);
      return { status: "ok", data: { deleted: noteId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de nota");
    }
  },
};

export const NOTES_TOOLS: ToolEntry[] = [createNote, getNote, updateNote, deleteNote];
