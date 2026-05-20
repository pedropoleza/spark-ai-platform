/**
 * Tools de metadata da location: custom fields, tags existentes, users.
 * Úteis pra IA descobrir IDs/keys antes de chamar update_field, add_tag, etc.
 */

import type { ToolEntry } from "./types";
import { ghlErrorToResult } from "./types";
import { listLocationCustomFields, listLocationTags, listLocationUsers } from "@/lib/ghl/operations";

const listCustomFields: ToolEntry = {
  def: {
    name: "list_custom_fields",
    description:
      "Lista custom fields da location ativa. Retorna id + name + key + type. Use antes de update_contact com custom_fields pra saber qual key/id usar.",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    try {
      const res = await listLocationCustomFields(ctx.ghlClient, ctx.locationId);
      return {
        status: "ok",
        data: (res.customFields || []).map((f) => ({
          id: f.id,
          name: f.name,
          key: f.fieldKey,
          type: f.dataType,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de custom fields");
    }
  },
};

const listTags: ToolEntry = {
  def: {
    name: "list_tags",
    description: "Lista todas as tags em uso na location. Útil pra evitar criar tag duplicada/typo.",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    try {
      const res = await listLocationTags(ctx.ghlClient, ctx.locationId);
      return {
        status: "ok",
        data: (res.tags || []).map((t) => ({ name: t.name, id: t.id })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de tags");
    }
  },
};

const listUsers: ToolEntry = {
  def: {
    name: "list_users",
    description: "Lista users da location ativa (incluindo o próprio rep e outros membros do time).",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    try {
      const res = await listLocationUsers(ctx.ghlClient, ctx.locationId);
      const users = res.users || [];
      if (users.length === 0) {
        return {
          status: "not_found",
          message: "Nenhum user nesta location ainda.",
        };
      }
      // Fix Track 3 #11 (review 2026-05-05): redução de PII — remove `phone`
      // do retorno. Use case típico (resolve assigned_to) só precisa de
      // id+name+role. Phone vazaria pro LLM e potencialmente pro histórico.
      return {
        status: "ok",
        data: users.map((u) => ({
          id: u.id,
          name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" "),
          email: u.email,
          role: u.roles?.role,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de users");
    }
  },
};

export const METADATA_TOOLS: ToolEntry[] = [listCustomFields, listTags, listUsers];
