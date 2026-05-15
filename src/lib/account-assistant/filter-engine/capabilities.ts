/**
 * Filter Engine — capability matrix.
 *
 * Documenta o que o GHL `/contacts/search` V2 e `/opportunities/search`
 * suportam SERVER-SIDE. Quando um (field, op) não é suportado, o
 * compiler escolhe estratégia client-side (pull all + filter local).
 *
 * Catálogo baseado em:
 *  - Sanity tests empíricos (Gustavo 2026-05-14: tags contains ✅, dateOfBirth eq ❌)
 *  - GHL Smart Lists docs (4 categorias: Date / DND / String / Numeric)
 *  - `_planning/ghl-api-reference.md` (linhas 22-180 contacts, 380-440 calendars)
 *  - Probe script `scripts/probe-ghl-capabilities.ts` (atualizado periodicamente)
 *
 * Como atualizar: rodar probe contra location estável, verificar diffs,
 * atualizar tabela. NÃO mudar sem evidência empírica.
 */

import type { FilterOp } from "./types";

// =====================================================================
// Field metadata
// =====================================================================

export type FieldType = "string" | "number" | "boolean" | "date" | "array" | "enum";

export interface FieldCapability {
  /** Tipo nativo do campo (define operators válidos) */
  type: FieldType;
  /** Endpoint que aceita server-side filter pra este campo */
  server_side_endpoint: "contacts_search" | "opportunities_search" | "none";
  /** GHL key name (pode diferir do FilterableField) */
  ghl_field_name: string;
  /** Operators suportados pelo GHL server-side */
  server_side_ops: FilterOp[];
  /** Operators que a engine cobre client-side se passar */
  client_side_ops: FilterOp[];
  /** Notas / quirks */
  notes?: string;
  /** Pode requerer custom field resolution (jamais hardcoded) */
  custom?: false;
}

// =====================================================================
// CONTACT_FIELDS — campos do contato direto
// =====================================================================

export const CONTACT_FIELDS: Record<string, FieldCapability> = {
  // === String fields (suporte server pleno) ===
  firstName: {
    type: "string",
    server_side_endpoint: "contacts_search",
    ghl_field_name: "firstName",
    server_side_ops: ["eq", "contains", "starts_with"],
    client_side_ops: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "exists", "not_exists"],
  },
  lastName: {
    type: "string",
    server_side_endpoint: "contacts_search",
    ghl_field_name: "lastName",
    server_side_ops: ["eq", "contains", "starts_with"],
    client_side_ops: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "exists", "not_exists"],
  },
  // fullName não tem endpoint próprio — usa query string GET /contacts/?query
  // ou compõe firstName+lastName client-side. Tratado em compiler.
  fullName: {
    type: "string",
    server_side_endpoint: "none",
    ghl_field_name: "name",
    server_side_ops: [],
    client_side_ops: ["eq", "contains", "starts_with", "ends_with"],
    notes: "Usa GET /contacts/?query pra fast path; fallback client-side join de firstName+lastName.",
  },
  email: {
    type: "string",
    server_side_endpoint: "contacts_search",
    ghl_field_name: "email",
    server_side_ops: ["eq", "contains"],
    client_side_ops: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "exists", "not_exists"],
    notes: "GHL probe 2026-05-15: 'exists' em field string retorna 422. Use client-side fallback.",
  },
  phone: {
    type: "string",
    server_side_endpoint: "contacts_search",
    ghl_field_name: "phone",
    server_side_ops: ["eq", "contains"],
    client_side_ops: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "exists", "not_exists"],
    notes: "GHL aceita E.164 OU dígitos puros. Normaliza antes de comparar. 'exists' não suportado server-side (422).",
  },
  // === Address ===
  address1: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "address1",
    server_side_ops: ["eq", "contains"], client_side_ops: ["eq", "neq", "contains", "starts_with", "ends_with", "exists", "not_exists"],
  },
  city: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "city",
    server_side_ops: ["eq", "contains"], client_side_ops: ["eq", "neq", "contains", "exists", "not_exists"],
  },
  state: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "state",
    server_side_ops: ["eq"],
    client_side_ops: ["eq", "neq", "in", "not_in", "exists", "not_exists"],
    notes: "GHL aceita 2-letter US states (FL, NY, CA) e nomes completos. 'in' não suportado server-side (probe 2026-05-15) → engine roda N queries paralelas + union.",
  },
  postalCode: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "postalCode",
    server_side_ops: ["eq", "starts_with"], client_side_ops: ["eq", "neq", "contains", "starts_with", "exists", "not_exists"],
  },
  country: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "country",
    server_side_ops: ["eq"], client_side_ops: ["eq", "neq", "in", "not_in"],
  },
  timezone: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "timezone",
    server_side_ops: [], client_side_ops: ["eq", "neq", "contains"],
    notes: "Não confirmado server-side — usar client filter.",
  },
  companyName: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "companyName",
    server_side_ops: ["eq", "contains"], client_side_ops: ["eq", "contains", "exists", "not_exists"],
  },
  source: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "source",
    server_side_ops: ["eq"], client_side_ops: ["eq", "neq", "exists", "not_exists"],
    notes: "'exists' não suportado em string server-side (probe 2026-05-15).",
  },
  // === Date fields (suporte server bom EXCETO dateOfBirth) ===
  dateOfBirth: {
    type: "date",
    server_side_endpoint: "none",                // FALHA — testado 2026-05-06: 422 Invalid Operator
    ghl_field_name: "dateOfBirth",
    server_side_ops: [],
    client_side_ops: ["eq", "neq", "before", "after", "between", "date_eq", "month_day_eq", "exists", "not_exists"],
    notes: "GHL bloqueia filter server-side. Engine pull all + filter local. Cap defensivo aplica.",
  },
  dateAdded: {
    type: "date", server_side_endpoint: "contacts_search", ghl_field_name: "dateAdded",
    server_side_ops: ["gt", "gte", "lt", "lte", "between"],
    client_side_ops: ["eq", "neq", "before", "after", "between", "gt", "gte", "lt", "lte"],
  },
  dateUpdated: {
    type: "date", server_side_endpoint: "contacts_search", ghl_field_name: "dateUpdated",
    server_side_ops: ["gt", "gte", "lt", "lte", "between"],
    client_side_ops: ["eq", "neq", "before", "after", "between", "gt", "gte", "lt", "lte"],
  },
  lastActivity: {
    type: "date", server_side_endpoint: "contacts_search", ghl_field_name: "lastActivity",
    server_side_ops: ["gt", "gte", "lt", "lte", "between", "exists", "not_exists"],
    client_side_ops: ["before", "after", "between", "exists", "not_exists"],
  },
  // === Array ===
  tags: {
    type: "array",
    server_side_endpoint: "contacts_search",
    ghl_field_name: "tags",
    server_side_ops: ["contains", "not_contains", "in"],         // ✅ confirmado sanity Gustavo
    client_side_ops: ["contains", "not_contains", "in", "not_in", "exists", "not_exists"],
    notes: "Tag matching é case-insensitive no GHL (testado).",
  },
  // === Boolean ===
  dnd: {
    type: "boolean", server_side_endpoint: "contacts_search", ghl_field_name: "dnd",
    server_side_ops: ["eq"], client_side_ops: ["eq", "neq"],
  },
  // === User reference ===
  assignedTo: {
    type: "string", server_side_endpoint: "contacts_search", ghl_field_name: "assignedTo",
    server_side_ops: ["eq"],
    client_side_ops: ["eq", "neq", "in", "not_in", "exists", "not_exists"],
    notes: "Aceita 'self' alias (resolver troca pra ghl_user_id do rep). 'in'/'exists' conservador → client-side.",
  },
};

// =====================================================================
// OPPORTUNITY_FIELDS — campos joinados via /opportunities/search
// =====================================================================

export const OPPORTUNITY_FIELDS: Record<string, FieldCapability> = {
  pipelineId: {
    type: "string", server_side_endpoint: "opportunities_search", ghl_field_name: "pipeline_id",
    server_side_ops: ["eq"], client_side_ops: ["eq", "neq", "in"],
  },
  stageId: {
    type: "string", server_side_endpoint: "opportunities_search", ghl_field_name: "pipeline_stage_id",
    server_side_ops: ["eq"], client_side_ops: ["eq", "neq", "in"],
  },
  stageName: {
    type: "string", server_side_endpoint: "none",
    ghl_field_name: "stage_name",
    server_side_ops: [],
    client_side_ops: ["eq", "contains", "in"],
    notes: "Alias — resolver troca pra stageId via list_pipelines cache.",
  },
  status: {
    type: "enum", server_side_endpoint: "opportunities_search", ghl_field_name: "status",
    server_side_ops: ["eq"], client_side_ops: ["eq", "in"],
    notes: "Valores: open|won|lost|abandoned|all. 'all' omite filter.",
  },
  monetaryValue: {
    type: "number", server_side_endpoint: "none",
    ghl_field_name: "monetary_value",
    server_side_ops: [],
    client_side_ops: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    notes:
      "GHL probe 2026-05-15: monetary_value_greater_than/less_than NÃO são mais query params válidos (422 'should not exist'). Engine pull all + filter local. Confirmar periodicamente se GHL libera filter de novo.",
  },
  assignedTo: {
    type: "string", server_side_endpoint: "opportunities_search", ghl_field_name: "assigned_to",
    server_side_ops: ["eq"], client_side_ops: ["eq", "neq", "in"],
  },
  createdAt: {
    type: "date", server_side_endpoint: "opportunities_search", ghl_field_name: "createdAt",
    server_side_ops: [], client_side_ops: ["before", "after", "between"],
    notes: "GHL não expõe filter server-side em createdAt — client side.",
  },
  updatedAt: {
    type: "date", server_side_endpoint: "opportunities_search", ghl_field_name: "updatedAt",
    server_side_ops: [], client_side_ops: ["before", "after", "between"],
  },
  lastStageChangeAt: {
    type: "date", server_side_endpoint: "opportunities_search", ghl_field_name: "lastStageChangeAt",
    server_side_ops: [], client_side_ops: ["before", "after", "between"],
  },
};

// =====================================================================
// Helpers
// =====================================================================

/** Resolve capability info pra um FilterableField. */
export function getFieldCapability(field: string): FieldCapability | null {
  // Opportunity prefix?
  if (field.startsWith("opportunity.")) {
    const subfield = field.slice("opportunity.".length);
    return OPPORTUNITY_FIELDS[subfield] || null;
  }
  // Custom field prefix?
  if (field.startsWith("customField.")) {
    // Custom fields têm capability dinâmica baseada no type retornado por
    // /locations/{id}/customFields. Default conservador: server-side
    // `eq` apenas; resto vai client-side. Resolver decide.
    return {
      type: "string",
      server_side_endpoint: "contacts_search",
      ghl_field_name: "customField",
      server_side_ops: ["eq"],
      client_side_ops: ["eq", "neq", "contains", "not_contains", "exists", "not_exists"],
      notes: "Custom field — capability completa depende do type detectado em runtime.",
    };
  }
  return CONTACT_FIELDS[field] || null;
}

/** Verifica se um par (field, op) é suportado server-side pelo GHL. */
export function isServerSideSupported(field: string, op: FilterOp): boolean {
  const cap = getFieldCapability(field);
  if (!cap) return false;
  return cap.server_side_ops.includes(op);
}

/** Verifica se um par (field, op) pode ser executado (server OU client). */
export function isAnyExecutable(field: string, op: FilterOp): boolean {
  const cap = getFieldCapability(field);
  if (!cap) return false;
  return cap.server_side_ops.includes(op) || cap.client_side_ops.includes(op);
}

/** Lista completa de fields conhecidos (pra describe_filter_capabilities tool). */
export function listKnownFields(): Array<{
  field: string;
  category: "contact" | "opportunity" | "custom";
  type: FieldType;
  server_side_ops: FilterOp[];
  client_side_ops: FilterOp[];
  notes?: string;
}> {
  const result: Array<{
    field: string;
    category: "contact" | "opportunity" | "custom";
    type: FieldType;
    server_side_ops: FilterOp[];
    client_side_ops: FilterOp[];
    notes?: string;
  }> = [];
  for (const [name, cap] of Object.entries(CONTACT_FIELDS)) {
    result.push({
      field: name,
      category: "contact",
      type: cap.type,
      server_side_ops: cap.server_side_ops,
      client_side_ops: cap.client_side_ops,
      notes: cap.notes,
    });
  }
  for (const [name, cap] of Object.entries(OPPORTUNITY_FIELDS)) {
    result.push({
      field: `opportunity.${name}`,
      category: "opportunity",
      type: cap.type,
      server_side_ops: cap.server_side_ops,
      client_side_ops: cap.client_side_ops,
      notes: cap.notes,
    });
  }
  return result;
}

/**
 * Operator → FieldType compatibility (validação semântica).
 * Ex: `gt` só faz sentido em number/date; `contains` em string/array.
 */
export function isOpCompatibleWithType(op: FilterOp, type: FieldType): boolean {
  switch (op) {
    case "eq":
    case "neq":
    case "exists":
    case "not_exists":
      return true; // qualquer tipo
    case "gt": case "gte": case "lt": case "lte": case "between":
      return type === "number" || type === "date";
    case "before": case "after": case "date_eq": case "month_day_eq":
      return type === "date";
    case "contains": case "not_contains":
      return type === "string" || type === "array";
    case "starts_with": case "ends_with":
      return type === "string";
    case "in": case "not_in":
      return true; // qualquer tipo aceita array de valores
  }
}
