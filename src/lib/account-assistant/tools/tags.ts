/**
 * Tools de Tags em contatos. Add e Remove separados (2 tools distintas).
 */

import type { ToolEntry } from "./types";
import { validateGhlId, ghlErrorToResult } from "./types";

const addTag: ToolEntry = {
  def: {
    name: "add_tag",
    description: "Adiciona uma ou mais tags a um contato.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "Lista de tags." },
      },
      required: ["contact_id", "tags"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const tags = Array.isArray(args.tags) ? (args.tags as string[]).filter(Boolean) : [];
    if (tags.length === 0) return { status: "error", message: "tags obrigatórias (array de strings)", retryable: false };

    try {
      await ctx.ghlClient.post(`/contacts/${contactId}/tags`, { tags });
      return { status: "ok", data: { added: tags } };
    } catch (err) {
      return ghlErrorToResult(err, "adição de tag");
    }
  },
};

const removeTag: ToolEntry = {
  def: {
    name: "remove_tag",
    description: "Remove uma ou mais tags de um contato.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["contact_id", "tags"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const tags = Array.isArray(args.tags) ? (args.tags as string[]).filter(Boolean) : [];
    if (tags.length === 0) return { status: "error", message: "tags obrigatórias", retryable: false };

    try {
      await ctx.ghlClient.delete(`/contacts/${contactId}/tags`, { tags });
      return { status: "ok", data: { removed: tags } };
    } catch (err) {
      return ghlErrorToResult(err, "remoção de tag");
    }
  },
};

export const TAGS_TOOLS: ToolEntry[] = [addTag, removeTag];
