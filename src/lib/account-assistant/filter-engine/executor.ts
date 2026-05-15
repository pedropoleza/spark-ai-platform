/**
 * Filter Engine — executor.
 *
 * Recebe um ExecutionPlan + context, roda as instruções em ordem, mantém
 * um workspace de sets nomeados (set_1, set_2, etc), aplica set operations
 * + client-side filters, retorna o conjunto final.
 *
 * Paginação ilimitada: cada ghl_search itera startAfter/searchAfter até
 * `complete` OU `cap` (default 5000 = 50 pages × 100). Cap configurável
 * via env FILTER_ENGINE_MAX_PAGES.
 */

import type {
  FilterExpression,
  FilterEntity,
  FilterCondition,
  FilterResult,
  ContactResult,
  OpportunityResult,
  FilterExecutionContext,
  FilterExecutionOptions,
  PlanStep,
} from "./types";
import { FilterEngineError } from "./types";
import type { PlanInstruction } from "./compiler";
import { compile } from "./compiler";
import { resolveAliases } from "./resolvers";
import { auditFilterExecution } from "./audit";

const PAGE_SIZE = 100;

// Workspace pra sets nomeados durante execução
interface Workspace {
  contacts: Map<string, ContactResult[]>;
  opportunities: Map<string, OpportunityResult[]>;
  /** Total reportado pelo GHL na 1ª página de cada set (ground truth) */
  totals_reported: Map<string, number>;
  pages_fetched_total: number;
  any_truncated: boolean;
}

// =====================================================================
// Public — entrypoint pra contacts
// =====================================================================

export async function executeContactsFilter(
  expr: FilterExpression,
  ctx: FilterExecutionContext,
  options: FilterExecutionOptions = {},
): Promise<FilterResult<ContactResult>> {
  return executeFilter("contacts", expr, ctx, options) as Promise<FilterResult<ContactResult>>;
}

export async function executeOpportunitiesFilter(
  expr: FilterExpression,
  ctx: FilterExecutionContext,
  options: FilterExecutionOptions = {},
): Promise<FilterResult<OpportunityResult>> {
  return executeFilter("opportunities", expr, ctx, options) as Promise<FilterResult<OpportunityResult>>;
}

// =====================================================================
// Core executor
// =====================================================================

async function executeFilter(
  entity: FilterEntity,
  expr: FilterExpression,
  ctx: FilterExecutionContext,
  options: FilterExecutionOptions,
): Promise<FilterResult<ContactResult | OpportunityResult>> {
  const start = Date.now();
  const planSteps: PlanStep[] = [];

  try {
    // 1) Resolve aliases
    const resolveResult = await resolveAliases(expr, ctx, { bypass_cache: options.bypass_cache });
    if (Object.keys(resolveResult.applied).length > 0) {
      planSteps.push({
        step: planSteps.length + 1,
        action: "ghl_pipelines_resolve",
        detail: `Aliases resolvidos: ${JSON.stringify(resolveResult.applied)}`,
      });
    }

    // 2) Compile
    const plan = compile(resolveResult.expr, entity);

    // 3) Execute
    const workspace: Workspace = {
      contacts: new Map(),
      opportunities: new Map(),
      totals_reported: new Map(),
      pages_fetched_total: 0,
      any_truncated: false,
    };
    const cap = Math.min(Math.max(options.limit || 5000, 1), 5000);

    let lastSetName = "";
    for (const inst of plan.steps) {
      const stepStart = Date.now();
      lastSetName = await runInstruction(inst, entity, ctx, workspace, cap, planSteps);
      const stepDuration = Date.now() - stepStart;
      // Update duration na última PlanStep
      if (planSteps.length > 0) {
        planSteps[planSteps.length - 1].duration_ms = stepDuration;
      }
    }

    // 4) Resultado final
    const finalSet: Array<ContactResult | OpportunityResult> =
      entity === "contacts"
        ? workspace.contacts.get(lastSetName) || []
        : workspace.opportunities.get(lastSetName) || [];

    const trimmed = finalSet.slice(0, cap);
    const totalReported = workspace.totals_reported.get(lastSetName);
    const complete = !workspace.any_truncated && trimmed.length === finalSet.length;

    const result: FilterResult<ContactResult | OpportunityResult> = {
      status: "ok",
      items: trimmed,
      total_returned: trimmed.length,
      total_reported_by_ghl: totalReported,
      complete,
      pages_fetched: workspace.pages_fetched_total,
      plan: planSteps,
      applied_aliases: resolveResult.applied,
      hit_safety_cap: workspace.any_truncated || trimmed.length < finalSet.length,
      duration_ms: Date.now() - start,
    };

    if (!options.skip_audit) {
      auditFilterExecution({ ctx, entity, fel: expr, result });
    }
    return result;
  } catch (err) {
    let result: FilterResult<ContactResult | OpportunityResult>;
    if (err instanceof FilterEngineError) {
      result = {
        status: "error",
        message: err.message,
        retryable: err.code === "GHL_ERROR",
        plan: planSteps,
        duration_ms: Date.now() - start,
      };
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        status: "error",
        message: `Filter Engine erro inesperado: ${msg}`,
        retryable: true,
        plan: planSteps,
        duration_ms: Date.now() - start,
      };
    }
    if (!options.skip_audit) {
      auditFilterExecution({ ctx, entity, fel: expr, result });
    }
    return result;
  }
}

// =====================================================================
// Run individual instruction
// =====================================================================

async function runInstruction(
  inst: PlanInstruction,
  entity: FilterEntity,
  ctx: FilterExecutionContext,
  workspace: Workspace,
  cap: number,
  planSteps: PlanStep[],
): Promise<string> {
  switch (inst.type) {
    case "ghl_search": {
      const result = await execGhlSearch(inst, entity, ctx, workspace, cap, planSteps);
      return result;
    }
    case "join_opp_to_contact":
      return execJoinOppToContact(inst, ctx, workspace, cap, planSteps);
    case "client_side_filter":
      return execClientSideFilter(inst, entity, workspace, planSteps);
    case "set_op":
      return execSetOp(inst, entity, workspace, planSteps);
  }
}

// =====================================================================
// GHL search execution (com paginação)
// =====================================================================

async function execGhlSearch(
  inst: Extract<PlanInstruction, { type: "ghl_search" }>,
  entity: FilterEntity,
  ctx: FilterExecutionContext,
  workspace: Workspace,
  cap: number,
  planSteps: PlanStep[],
): Promise<string> {
  planSteps.push({
    step: planSteps.length + 1,
    action: "ghl_search",
    detail: `${inst.endpoint} filters=${JSON.stringify(inst.ghl_filters)} extra=${JSON.stringify(inst.extra_params || {})}`,
    ghl_endpoint: inst.endpoint,
    ghl_params: inst.extra_params,
  });

  if (inst.endpoint === "contacts_search_v2") {
    const items = await paginateContactsSearch(inst, ctx, workspace, cap);
    workspace.contacts.set(inst.output_set, items);
    if (planSteps.length > 0) planSteps[planSteps.length - 1].result_count = items.length;
    return inst.output_set;
  }
  if (inst.endpoint === "contacts_search_v1_get") {
    const items = await paginateContactsGet(inst, ctx, workspace, cap);
    workspace.contacts.set(inst.output_set, items);
    if (planSteps.length > 0) planSteps[planSteps.length - 1].result_count = items.length;
    return inst.output_set;
  }
  if (inst.endpoint === "opportunities_search") {
    const items = await paginateOpportunitiesSearch(inst, ctx, workspace, cap);
    workspace.opportunities.set(inst.output_set, items);
    if (planSteps.length > 0) planSteps[planSteps.length - 1].result_count = items.length;
    return inst.output_set;
  }
  throw new FilterEngineError(`Endpoint desconhecido: ${(inst as { endpoint: string }).endpoint}`, "GHL_ERROR");
}

async function paginateContactsSearch(
  inst: Extract<PlanInstruction, { type: "ghl_search" }>,
  ctx: FilterExecutionContext,
  workspace: Workspace,
  cap: number,
): Promise<ContactResult[]> {
  type Resp = {
    contacts?: Array<{
      id: string;
      firstName?: string; lastName?: string;
      contactName?: string; name?: string;
      email?: string; phone?: string;
      tags?: string[]; dateOfBirth?: string;
      dateAdded?: string; dateUpdated?: string; lastActivity?: string;
      assignedTo?: string;
      customFields?: Array<{ id: string; key?: string; value: string }>;
    }>;
    total?: number;
    searchAfter?: unknown[] | string;
  };
  const all: ContactResult[] = [];
  let cursor: unknown[] | string | undefined;
  let pagesFetched = 0;
  let totalReported: number | undefined;
  const MAX_PAGES = Math.ceil(cap / PAGE_SIZE);

  while (pagesFetched < MAX_PAGES) {
    const body: Record<string, unknown> = {
      locationId: ctx.location_id,
      filters: inst.ghl_filters,
      pageLimit: PAGE_SIZE,
    };
    if (cursor !== undefined) body.searchAfter = cursor;
    if (inst.extra_params) Object.assign(body, inst.extra_params);

    let res: Resp;
    try {
      res = await ctx.ghl_client.post<Resp>("/contacts/search", body);
    } catch (err) {
      throw new FilterEngineError(
        `GHL /contacts/search falhou: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
        "GHL_ERROR",
        { body, err: String(err) },
      );
    }

    pagesFetched++;
    workspace.pages_fetched_total++;

    if (totalReported === undefined && typeof res.total === "number") {
      totalReported = res.total;
      workspace.totals_reported.set(inst.output_set, totalReported);
    }

    const page = res.contacts || [];
    for (const c of page) {
      all.push(mapContactFromGhl(c));
    }

    const next = res.searchAfter;
    const empty =
      next === undefined || next === null ||
      (Array.isArray(next) && next.length === 0) ||
      (typeof next === "string" && next === "");
    if (empty || page.length === 0) break;
    if (JSON.stringify(next) === JSON.stringify(cursor)) break; // anti-loop
    cursor = next;

    if (all.length >= cap) {
      workspace.any_truncated = true;
      break;
    }
  }

  return all.slice(0, cap);
}

async function paginateContactsGet(
  inst: Extract<PlanInstruction, { type: "ghl_search" }>,
  ctx: FilterExecutionContext,
  workspace: Workspace,
  cap: number,
): Promise<ContactResult[]> {
  // GET /contacts/?query — fast path quando filter é só query string
  type Resp = {
    contacts?: Array<{
      id: string;
      firstName?: string; lastName?: string;
      contactName?: string; name?: string;
      email?: string; phone?: string;
      tags?: string[]; lastActivity?: string;
    }>;
  };
  const all: ContactResult[] = [];
  let startAfter: string | undefined;
  let pagesFetched = 0;
  const MAX_PAGES = Math.ceil(cap / PAGE_SIZE);

  while (pagesFetched < MAX_PAGES) {
    const params: Record<string, string> = {
      locationId: ctx.location_id,
      limit: String(PAGE_SIZE),
      ...(inst.extra_params || {}),
    };
    if (startAfter) params.startAfterId = startAfter;

    const res = await ctx.ghl_client.get<Resp>("/contacts/", params);
    pagesFetched++;
    workspace.pages_fetched_total++;

    const page = res.contacts || [];
    if (page.length === 0) break;
    for (const c of page) all.push(mapContactFromGhl(c));

    if (page.length < PAGE_SIZE) break;
    startAfter = page[page.length - 1].id;
    if (all.length >= cap) {
      workspace.any_truncated = true;
      break;
    }
  }
  return all.slice(0, cap);
}

async function paginateOpportunitiesSearch(
  inst: Extract<PlanInstruction, { type: "ghl_search" }>,
  ctx: FilterExecutionContext,
  workspace: Workspace,
  cap: number,
): Promise<OpportunityResult[]> {
  type GhlCustomFieldEntry = {
    id: string;
    fieldValue?: string | number | string[];
    fieldValueString?: string;
    fieldValueNumber?: number;
    fieldValueArray?: string[];
  };
  type Resp = {
    opportunities?: Array<{
      id: string;
      name?: string;
      monetaryValue?: number;
      status?: string;
      pipelineId?: string;
      pipelineStageId?: string;
      contactId?: string;
      assignedTo?: string;
      createdAt?: string;
      updatedAt?: string;
      lastStageChangeAt?: string;
      customFields?: GhlCustomFieldEntry[];
      contact?: { id: string; name?: string };
    }>;
    meta?: {
      total?: number;
      startAfterId?: string;
      startAfter?: number;
    };
  };
  const all: OpportunityResult[] = [];
  let cursor: { startAfterId?: string; startAfter?: number } = {};
  let pagesFetched = 0;
  let totalReported: number | undefined;
  const MAX_PAGES = Math.ceil(cap / PAGE_SIZE);

  while (pagesFetched < MAX_PAGES) {
    const params: Record<string, string> = {
      location_id: ctx.location_id,
      limit: String(PAGE_SIZE),
      ...(inst.extra_params || {}),
    };
    if (cursor.startAfterId) params.startAfterId = cursor.startAfterId;
    if (cursor.startAfter !== undefined) params.startAfter = String(cursor.startAfter);

    const res = await ctx.ghl_client.get<Resp>("/opportunities/search", params);
    pagesFetched++;
    workspace.pages_fetched_total++;

    if (totalReported === undefined && typeof res.meta?.total === "number") {
      totalReported = res.meta.total;
      workspace.totals_reported.set(inst.output_set, totalReported);
    }

    const page = res.opportunities || [];
    for (const o of page) {
      all.push({
        id: o.id,
        name: o.name || null,
        monetaryValue: o.monetaryValue || 0,
        status: o.status || "open",
        pipelineId: o.pipelineId || "",
        stageId: o.pipelineStageId || "",
        contactId: o.contactId || "",
        contactName: o.contact?.name || null,
        assignedTo: o.assignedTo || null,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        lastStageChangeAt: o.lastStageChangeAt,
        // Pedro 2026-05-15: customFields embedded — engine usa pra client-side
        // filter de `opportunity.customField.*`.
        customFields: o.customFields,
      });
    }

    const next = res.meta?.startAfterId;
    if (!next || page.length === 0) break;
    if (next === cursor.startAfterId) break;
    cursor = { startAfterId: next, startAfter: res.meta?.startAfter };

    if (all.length >= cap) {
      workspace.any_truncated = true;
      break;
    }
  }
  return all.slice(0, cap);
}

// =====================================================================
// Join opp → contact
// =====================================================================

async function execJoinOppToContact(
  inst: Extract<PlanInstruction, { type: "join_opp_to_contact" }>,
  ctx: FilterExecutionContext,
  workspace: Workspace,
  cap: number,
  planSteps: PlanStep[],
): Promise<string> {
  const opps = workspace.opportunities.get(inst.input_set) || [];
  const dedupContactIds = Array.from(new Set(opps.map((o) => o.contactId).filter(Boolean)));

  planSteps.push({
    step: planSteps.length + 1,
    action: "join_opp_to_contact",
    detail: `${opps.length} opps → ${dedupContactIds.length} contact_ids únicos`,
    result_count: dedupContactIds.length,
  });

  // Fetch contacts em batches via GET /contacts/{id}. Paraleliza limitado.
  const BATCH = 10;
  const contacts: ContactResult[] = [];
  for (let i = 0; i < dedupContactIds.length && contacts.length < cap; i += BATCH) {
    const ids = dedupContactIds.slice(i, i + BATCH);
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await ctx.ghl_client.get<{
            contact: {
              id: string;
              firstName?: string; lastName?: string;
              name?: string; email?: string; phone?: string;
              tags?: string[]; dateOfBirth?: string;
              dateAdded?: string; lastActivity?: string;
            };
          }>(`/contacts/${id}`);
          return res.contact ? mapContactFromGhl(res.contact) : null;
        } catch {
          return null;
        }
      }),
    );
    for (const c of results) if (c) contacts.push(c);
  }

  workspace.contacts.set(inst.output_set, contacts);
  return inst.output_set;
}

// =====================================================================
// Client-side filter
// =====================================================================

function execClientSideFilter(
  inst: Extract<PlanInstruction, { type: "client_side_filter" }>,
  entity: FilterEntity,
  workspace: Workspace,
  planSteps: PlanStep[],
): string {
  const input = entity === "contacts"
    ? workspace.contacts.get(inst.input_set) || []
    : workspace.opportunities.get(inst.input_set) || [];

  const filtered = input.filter((item) => {
    if (inst.combinator === "and") {
      return inst.conditions.every((c) => evalConditionClient(c, item));
    } else {
      return inst.conditions.some((c) => evalConditionClient(c, item));
    }
  });

  planSteps.push({
    step: planSteps.length + 1,
    action: "client_side_filter",
    detail: `${input.length} → ${filtered.length} after ${inst.conditions.map((c) => `${c.field} ${c.op}`).join(", ")}`,
    result_count: filtered.length,
  });

  if (entity === "contacts") workspace.contacts.set(inst.output_set, filtered as ContactResult[]);
  else workspace.opportunities.set(inst.output_set, filtered as OpportunityResult[]);

  return inst.output_set;
}

function evalConditionClient(
  cond: FilterCondition,
  item: ContactResult | OpportunityResult,
): boolean {
  const fieldValue = extractFieldValue(cond.field, item);

  switch (cond.op) {
    case "exists": return fieldValue !== null && fieldValue !== undefined && fieldValue !== "";
    case "not_exists": return fieldValue === null || fieldValue === undefined || fieldValue === "";
    case "eq": return String(fieldValue ?? "").toLowerCase() === String(cond.value ?? "").toLowerCase();
    case "neq": return String(fieldValue ?? "").toLowerCase() !== String(cond.value ?? "").toLowerCase();
    case "contains":
      if (Array.isArray(fieldValue)) {
        return fieldValue.some((v) => String(v).toLowerCase().includes(String(cond.value).toLowerCase()));
      }
      return String(fieldValue ?? "").toLowerCase().includes(String(cond.value ?? "").toLowerCase());
    case "not_contains":
      if (Array.isArray(fieldValue)) {
        return !fieldValue.some((v) => String(v).toLowerCase().includes(String(cond.value).toLowerCase()));
      }
      return !String(fieldValue ?? "").toLowerCase().includes(String(cond.value ?? "").toLowerCase());
    case "starts_with":
      return String(fieldValue ?? "").toLowerCase().startsWith(String(cond.value ?? "").toLowerCase());
    case "ends_with":
      return String(fieldValue ?? "").toLowerCase().endsWith(String(cond.value ?? "").toLowerCase());
    case "in":
      if (Array.isArray(cond.value)) {
        return cond.value.some((v) => String(v).toLowerCase() === String(fieldValue ?? "").toLowerCase());
      }
      return false;
    case "not_in":
      if (Array.isArray(cond.value)) {
        return !cond.value.some((v) => String(v).toLowerCase() === String(fieldValue ?? "").toLowerCase());
      }
      return true;
    case "gt": return Number(fieldValue) > Number(cond.value);
    case "gte": return Number(fieldValue) >= Number(cond.value);
    case "lt": return Number(fieldValue) < Number(cond.value);
    case "lte": return Number(fieldValue) <= Number(cond.value);
    case "between":
      if (typeof cond.value === "object" && cond.value !== null && "from" in cond.value) {
        const r = cond.value as { from: string | number; to: string | number };
        return Number(fieldValue) >= Number(r.from) && Number(fieldValue) <= Number(r.to);
      }
      return false;
    case "before":
      return new Date(String(fieldValue)).getTime() < new Date(String(cond.value)).getTime();
    case "after":
      return new Date(String(fieldValue)).getTime() > new Date(String(cond.value)).getTime();
    case "date_eq":
      return String(fieldValue ?? "").slice(0, 10) === String(cond.value ?? "").slice(0, 10);
    case "month_day_eq": {
      const v = String(fieldValue ?? "");
      // Aceita YYYY-MM-DD ou DD-MM-YYYY etc. Extrai MM-DD.
      const m = v.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return false;
      const mmdd = `${m[2]}-${m[3]}`;
      return mmdd === String(cond.value ?? "");
    }
  }
}

function extractFieldValue(
  field: string,
  item: ContactResult | OpportunityResult,
): unknown {
  const rec = item as unknown as Record<string, unknown>;

  // Opportunity custom field — Pedro 2026-05-15
  if (field.startsWith("opportunity.customField.")) {
    const ref = field.slice("opportunity.customField.".length);
    const oppItem =
      "opportunities" in item && item.opportunities && item.opportunities.length > 0
        ? item.opportunities[0]
        : (item as OpportunityResult);
    const cfs = (oppItem as { customFields?: Array<Record<string, unknown>> }).customFields;
    if (!Array.isArray(cfs)) return undefined;
    const cf = cfs.find((c) => c.id === ref);
    if (!cf) return undefined;
    // GHL retorna valor em campos variados conforme dataType.
    // fieldValueDate é timestamp ms — convert pra ISO string pra comparar
    // com operators temporais (before, after, month_day_eq, etc).
    if (typeof cf.fieldValueDate === "number") {
      return new Date(cf.fieldValueDate).toISOString();
    }
    return (
      cf.fieldValue ??
      cf.fieldValueString ??
      cf.fieldValueNumber ??
      cf.fieldValueArray
    );
  }

  if (field.startsWith("opportunity.")) {
    const sub = field.slice("opportunity.".length);
    if ("opportunities" in item && item.opportunities && item.opportunities.length > 0) {
      return (item.opportunities[0] as unknown as Record<string, unknown>)[sub];
    }
    return rec[sub];
  }

  // Contact custom field
  if (field.startsWith("customField.")) {
    const ref = field.slice("customField.".length);
    if ("customFields" in item && Array.isArray(item.customFields)) {
      // Contact CFs têm shape { id, key?, value } — opp CFs têm shape diferente.
      // Aqui só contact entra (compiler garante o roteamento por field prefix).
      const found = item.customFields.find((cf) => {
        const c = cf as { id?: string; key?: string };
        return c.id === ref || c.key === ref;
      });
      return (found as { value?: unknown } | undefined)?.value;
    }
    return undefined;
  }
  return rec[field];
}

// =====================================================================
// Set operations
// =====================================================================

function execSetOp(
  inst: Extract<PlanInstruction, { type: "set_op" }>,
  entity: FilterEntity,
  workspace: Workspace,
  planSteps: PlanStep[],
): string {
  const inputs = inst.input_sets.map((s) =>
    entity === "contacts"
      ? (workspace.contacts.get(s) || []) as Array<ContactResult>
      : (workspace.opportunities.get(s) || []) as Array<OpportunityResult>,
  );

  let result: Array<ContactResult | OpportunityResult>;
  switch (inst.op) {
    case "intersection": {
      if (inputs.length === 0) {
        result = [];
        break;
      }
      let acc = new Set(inputs[0].map((i) => i.id));
      for (let i = 1; i < inputs.length; i++) {
        const ids = new Set(inputs[i].map((x) => x.id));
        acc = new Set([...acc].filter((id) => ids.has(id)));
      }
      result = inputs[0].filter((i) => acc.has(i.id));
      break;
    }
    case "union": {
      const seen = new Set<string>();
      result = [];
      for (const set of inputs) {
        for (const i of set) {
          if (!seen.has(i.id)) {
            seen.add(i.id);
            result.push(i);
          }
        }
      }
      break;
    }
    case "difference": {
      if (inputs.length < 2) {
        result = inputs[0] || [];
        break;
      }
      const exclude = new Set<string>();
      for (let i = 1; i < inputs.length; i++) {
        for (const item of inputs[i]) exclude.add(item.id);
      }
      result = inputs[0].filter((i) => !exclude.has(i.id));
      break;
    }
  }

  planSteps.push({
    step: planSteps.length + 1,
    action: inst.op === "intersection" ? "intersection" : inst.op === "union" ? "union" : "dedup",
    detail: `${inst.input_sets.join(" ∩ ")} → ${result.length}`,
    result_count: result.length,
  });

  if (entity === "contacts") workspace.contacts.set(inst.output_set, result as ContactResult[]);
  else workspace.opportunities.set(inst.output_set, result as OpportunityResult[]);

  return inst.output_set;
}

// =====================================================================
// Mappers
// =====================================================================

function mapContactFromGhl(c: {
  id: string;
  firstName?: string; lastName?: string;
  contactName?: string; name?: string;
  email?: string; phone?: string;
  tags?: string[]; dateOfBirth?: string;
  dateAdded?: string; dateUpdated?: string; lastActivity?: string;
  assignedTo?: string;
  customFields?: Array<{ id: string; key?: string; value: string }>;
}): ContactResult {
  return {
    id: c.id,
    name: c.contactName || c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || null,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email || null,
    phone: c.phone || null,
    tags: c.tags || [],
    dateOfBirth: c.dateOfBirth || null,
    dateAdded: c.dateAdded || null,
    dateUpdated: c.dateUpdated || null,
    lastActivity: c.lastActivity || null,
    assignedTo: c.assignedTo || null,
    customFields: c.customFields,
  };
}

// =====================================================================
// COUNT (lightweight — só lê meta.total)
// =====================================================================

export async function countFilter(
  entity: FilterEntity,
  expr: FilterExpression,
  ctx: FilterExecutionContext,
  options: FilterExecutionOptions = {},
): Promise<{ count: number; complete: boolean; plan: PlanStep[]; applied_aliases: Record<string, string> }> {
  // Resolve aliases
  const resolveResult = await resolveAliases(expr, ctx, options);
  const plan = compile(resolveResult.expr, entity);

  // Otimização: se plan tem 1 ghl_search e ZERO client_side_filters/set_ops,
  // dá pra fazer 1 chamada com pageLimit:1 e ler meta.total.
  const isSimple =
    plan.steps.length === 1 &&
    plan.steps[0].type === "ghl_search" &&
    !plan.may_truncate;

  if (isSimple) {
    const inst = plan.steps[0] as Extract<PlanInstruction, { type: "ghl_search" }>;
    if (inst.endpoint === "contacts_search_v2") {
      const body: Record<string, unknown> = {
        locationId: ctx.location_id,
        filters: inst.ghl_filters,
        pageLimit: 1,
      };
      if (inst.extra_params) Object.assign(body, inst.extra_params);
      const res = await ctx.ghl_client.post<{ total?: number }>("/contacts/search", body);
      return {
        count: res.total || 0,
        complete: true,
        plan: [{
          step: 1,
          action: "ghl_search",
          detail: "Count-only (pageLimit:1)",
          ghl_endpoint: "contacts_search_v2",
        }],
        applied_aliases: resolveResult.applied,
      };
    }
    if (inst.endpoint === "opportunities_search") {
      const params: Record<string, string> = {
        location_id: ctx.location_id,
        limit: "1",
        ...(inst.extra_params || {}),
      };
      const res = await ctx.ghl_client.get<{ meta?: { total?: number } }>(
        "/opportunities/search",
        params,
      );
      return {
        count: res.meta?.total || 0,
        complete: true,
        plan: [{
          step: 1,
          action: "ghl_search",
          detail: "Count-only opps (limit:1)",
          ghl_endpoint: "opportunities_search",
        }],
        applied_aliases: resolveResult.applied,
      };
    }
  }

  // Não é simples: executa filter completo e conta items
  const result = await executeFilter(entity, expr, ctx, options);
  return {
    count: result.total_returned || 0,
    complete: result.complete || false,
    plan: result.plan || [],
    applied_aliases: result.applied_aliases || {},
  };
}
