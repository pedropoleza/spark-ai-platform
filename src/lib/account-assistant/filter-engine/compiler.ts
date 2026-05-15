/**
 * Filter Engine — compiler.
 *
 * Recebe um FilterExpression (pós-resolução de aliases) e produz um
 * ExecutionPlan: lista ordenada de passos (chamadas GHL + ops client-side)
 * que o executor processa pra produzir o conjunto final de contatos/opps.
 *
 * Estratégias suportadas V1:
 *  - Single leaf contact field → search V2 com filter
 *  - Single leaf opportunity field → opportunities/search → extract contact_ids → fetch
 *  - AND de leaves → split em contact filters + opp filters, intersect
 *  - OR de leaves SIMPLES (mesmo field) → IN operator quando possível, senão N queries paralelas + union
 *  - OR misto / NOT / nesting profundo V1 → fallback "pull broader + client-side filter"
 *
 * Cap defensivo no compile: max 5 níveis de nesting, max 20 leaves
 * total. Erro útil pro LLM simplificar.
 */

import type {
  FilterExpression,
  FilterCondition,
  FilterOp,
  FilterEntity,
} from "./types";
import { FilterEngineError, isComposite, isLeaf } from "./types";
import { getFieldCapability, isOpCompatibleWithType } from "./capabilities";

// =====================================================================
// ExecutionPlan
// =====================================================================

export interface ExecutionPlan {
  entity: FilterEntity;
  /** Passos ordenados — executor roda em sequência, alguns paralelos */
  steps: PlanInstruction[];
  /** True se o conjunto final pode estar truncado pelo cap */
  may_truncate: boolean;
  /** Estimativa de chamadas GHL (pra logging/billing) */
  estimated_ghl_calls: number;
}

export type PlanInstruction =
  | GhlSearchInstruction
  | OppToContactJoinInstruction
  | ClientSideFilterInstruction
  | SetOpInstruction;

interface GhlSearchInstruction {
  type: "ghl_search";
  endpoint: "contacts_search_v2" | "contacts_search_v1_get" | "opportunities_search";
  /** Filters a enviar ao GHL */
  ghl_filters: Array<{ field: string; operator: string; value: unknown }>;
  /** Extra query params (locationId, status, etc) */
  extra_params?: Record<string, string>;
  /** Output set name — passos seguintes referenciam */
  output_set: string;
}

interface OppToContactJoinInstruction {
  type: "join_opp_to_contact";
  /** Set de opps cujos contact_ids extrair */
  input_set: string;
  output_set: string;
}

interface ClientSideFilterInstruction {
  type: "client_side_filter";
  input_set: string;
  /** Filters a aplicar localmente no resultado */
  conditions: FilterCondition[];
  /** AND entre conditions, ou OR */
  combinator: "and" | "or";
  output_set: string;
}

interface SetOpInstruction {
  type: "set_op";
  op: "intersection" | "union" | "difference";
  input_sets: string[];
  output_set: string;
}

// =====================================================================
// Public API
// =====================================================================

export function compile(
  expr: FilterExpression,
  entity: FilterEntity,
): ExecutionPlan {
  // Validações primeiro
  validateDepth(expr, 0);
  const leafCount = countLeaves(expr);
  if (leafCount > 20) {
    throw new FilterEngineError(
      `FEL tem ${leafCount} condições — máximo é 20. Simplifique ou combine filtros.`,
      "DEPTH_LIMIT",
      { leaf_count: leafCount },
    );
  }
  if (leafCount === 0) {
    throw new FilterEngineError(
      "FEL sem condições — passe pelo menos 1 filter (ex: { all: [{ field, op, value }] })",
      "INVALID_FEL",
    );
  }

  // Validação semântica
  validateSemantic(expr);

  // Build plan
  const plan: PlanInstruction[] = [];
  const counter = { n: 0 };
  compileExpr(expr, entity, plan, counter);

  const estimated = plan.filter((s) => s.type === "ghl_search").length;

  return {
    entity,
    steps: plan,
    may_truncate: plan.some((s) => s.type === "client_side_filter"),
    estimated_ghl_calls: estimated,
  };
}

// =====================================================================
// Recursive compile
// =====================================================================

function compileExpr(
  expr: FilterExpression,
  entity: FilterEntity,
  plan: PlanInstruction[],
  counter: { n: number },
): string {
  if (isLeaf(expr)) {
    return compileLeaf(expr, entity, plan, counter);
  }
  if (isComposite(expr)) {
    if ("all" in expr) {
      // AND: cada filho gera um set; depois intersection
      const childSets = expr.all.map((child) => compileExpr(child, entity, plan, counter));
      if (childSets.length === 1) return childSets[0];
      const out = nextSet(counter);
      plan.push({
        type: "set_op",
        op: "intersection",
        input_sets: childSets,
        output_set: out,
      });
      return out;
    }
    if ("any" in expr) {
      // OR: pode otimizar se todos children são leaves com mesmo field e operator suporta 'in'
      const allLeaves = expr.any.every(isLeaf);
      if (allLeaves && canMergeAsIn(expr.any as FilterCondition[])) {
        const merged = mergeAsIn(expr.any as FilterCondition[]);
        return compileLeaf(merged, entity, plan, counter);
      }
      // Senão: N queries paralelas + union
      const childSets = expr.any.map((child) => compileExpr(child, entity, plan, counter));
      if (childSets.length === 1) return childSets[0];
      const out = nextSet(counter);
      plan.push({
        type: "set_op",
        op: "union",
        input_sets: childSets,
        output_set: out,
      });
      return out;
    }
    if ("not" in expr) {
      // NOT: precisa fetch broader set + remover os que batem.
      // V1 simplificado: NOT só funciona se for top-level OU dentro de AND.
      // Implementação: invertemos o operator quando possível, ou fazemos
      // client-side filter de NEGATIVE.
      if (isLeaf(expr.not)) {
        const negated = negateLeaf(expr.not);
        if (negated) return compileLeaf(negated, entity, plan, counter);
      }
      throw new FilterEngineError(
        "NOT complexo (não-leaf ou operator não-invertível) não suportado V1. Reescreva como leaf com operator negativo (ex: neq, not_contains, not_exists).",
        "INVALID_FEL",
        { expr: expr.not },
      );
    }
  }
  throw new FilterEngineError(
    `FilterExpression malformado: ${JSON.stringify(expr).slice(0, 100)}`,
    "INVALID_FEL",
  );
}

// =====================================================================
// Compile leaf — gera instruções pra UMA condition
// =====================================================================

function compileLeaf(
  cond: FilterCondition,
  entity: FilterEntity,
  plan: PlanInstruction[],
  counter: { n: number },
): string {
  const cap = getFieldCapability(cond.field);
  if (!cap) {
    throw new FilterEngineError(
      `Field '${cond.field}' não reconhecido. Use describe_filter_capabilities pra ver fields disponíveis.`,
      "UNSUPPORTED_FIELD",
      { field: cond.field },
    );
  }

  const isOppField = cond.field.startsWith("opportunity.");
  const isCustomField = cond.field.startsWith("customField.");
  const supportsServer = cap.server_side_ops.includes(cond.op);

  // === Case 1: contact field, server-side ok, entity = contacts ===
  if (!isOppField && supportsServer && entity === "contacts") {
    const setOut = nextSet(counter);
    plan.push({
      type: "ghl_search",
      endpoint: "contacts_search_v2",
      ghl_filters: [
        {
          field: isCustomField ? "customField" : cap.ghl_field_name,
          operator: mapOpToGhl(cond.op),
          value: cond.value,
        },
      ],
      extra_params: isCustomField
        ? { customFieldId: cond.field.slice("customField.".length) }
        : undefined,
      output_set: setOut,
    });
    return setOut;
  }

  // === Case 2: opportunity field, server-side ok ===
  if (isOppField && supportsServer) {
    const subfield = cond.field.slice("opportunity.".length);
    // monetary_value precisa de mapeamento special pro GHL (greater_than / less_than)
    const ghlParams = buildOppQueryParams(subfield, cond.op, cond.value);
    const oppSet = nextSet(counter);
    plan.push({
      type: "ghl_search",
      endpoint: "opportunities_search",
      ghl_filters: [],
      extra_params: ghlParams,
      output_set: oppSet,
    });
    if (entity === "contacts") {
      // Join: extrair contact_ids
      const contactSet = nextSet(counter);
      plan.push({
        type: "join_opp_to_contact",
        input_set: oppSet,
        output_set: contactSet,
      });
      return contactSet;
    }
    return oppSet;
  }

  // === Case 3: precisa client-side ===
  // Estratégia: fetch broader (com filters server-side já aplicados das outras
  // ANDs OU pull all se nada server). Aqui simplificamos: fetch entity all
  // (com cap) e filtra client-side.
  const broaderSet = nextSet(counter);
  if (entity === "contacts") {
    plan.push({
      type: "ghl_search",
      endpoint: "contacts_search_v2",
      ghl_filters: [],
      extra_params: undefined,
      output_set: broaderSet,
    });
  } else {
    plan.push({
      type: "ghl_search",
      endpoint: "opportunities_search",
      ghl_filters: [],
      extra_params: { status: "all" },
      output_set: broaderSet,
    });
  }
  const filteredSet = nextSet(counter);
  plan.push({
    type: "client_side_filter",
    input_set: broaderSet,
    conditions: [cond],
    combinator: "and",
    output_set: filteredSet,
  });
  return filteredSet;
}

// =====================================================================
// Helpers
// =====================================================================

function nextSet(counter: { n: number }): string {
  counter.n++;
  return `set_${counter.n}`;
}

function validateDepth(expr: FilterExpression, depth: number): void {
  if (depth > 5) {
    throw new FilterEngineError(
      "FEL muito aninhado (>5 níveis). Achata combinando filters.",
      "DEPTH_LIMIT",
    );
  }
  if (isComposite(expr)) {
    if ("all" in expr) for (const c of expr.all) validateDepth(c, depth + 1);
    else if ("any" in expr) for (const c of expr.any) validateDepth(c, depth + 1);
    else if ("not" in expr) validateDepth(expr.not, depth + 1);
  }
}

function countLeaves(expr: FilterExpression): number {
  if (isLeaf(expr)) return 1;
  if (isComposite(expr)) {
    if ("all" in expr) return expr.all.reduce((a, c) => a + countLeaves(c), 0);
    if ("any" in expr) return expr.any.reduce((a, c) => a + countLeaves(c), 0);
    if ("not" in expr) return countLeaves(expr.not);
  }
  return 0;
}

function validateSemantic(expr: FilterExpression): void {
  if (isLeaf(expr)) {
    const cap = getFieldCapability(expr.field);
    if (!cap) {
      throw new FilterEngineError(
        `Field '${expr.field}' desconhecido. Use describe_filter_capabilities.`,
        "UNSUPPORTED_FIELD",
        { field: expr.field },
      );
    }
    if (!isOpCompatibleWithType(expr.op, cap.type)) {
      throw new FilterEngineError(
        `Operator '${expr.op}' não compatível com field '${expr.field}' (tipo ${cap.type}).`,
        "UNSUPPORTED_OPERATOR",
        { field: expr.field, op: expr.op, type: cap.type },
      );
    }
    return;
  }
  if (isComposite(expr)) {
    if ("all" in expr) expr.all.forEach(validateSemantic);
    else if ("any" in expr) expr.any.forEach(validateSemantic);
    else if ("not" in expr) validateSemantic(expr.not);
  }
}

function canMergeAsIn(conds: FilterCondition[]): boolean {
  if (conds.length < 2) return false;
  const first = conds[0];
  return conds.every(
    (c) =>
      c.field === first.field &&
      (c.op === "eq" || c.op === "in") &&
      (typeof c.value === "string" || typeof c.value === "number"),
  );
}

function mergeAsIn(conds: FilterCondition[]): FilterCondition {
  const values: Array<string | number> = [];
  for (const c of conds) {
    if (typeof c.value === "string" || typeof c.value === "number") values.push(c.value);
  }
  return { field: conds[0].field, op: "in", value: values as string[] | number[] };
}

function negateLeaf(cond: FilterCondition): FilterCondition | null {
  const inv: Partial<Record<FilterOp, FilterOp>> = {
    eq: "neq", neq: "eq",
    contains: "not_contains", not_contains: "contains",
    exists: "not_exists", not_exists: "exists",
    in: "not_in", not_in: "in",
    gt: "lte", lt: "gte", gte: "lt", lte: "gt",
  };
  const newOp = inv[cond.op];
  if (!newOp) return null;
  return { ...cond, op: newOp };
}

function mapOpToGhl(op: FilterOp): string {
  // GHL search V2 usa nomes próprios:
  //   eq → 'eq'
  //   contains → 'contains'
  //   gt → 'gt' (não confirmado V1 — só dateAdded etc aceitam)
  //   etc.
  // Pra V1 mantemos mapping 1:1 e ajustamos se probe revelar diferenças.
  return op;
}

function buildOppQueryParams(
  subfield: string,
  op: FilterOp,
  value: unknown,
): Record<string, string> {
  // /opportunities/search aceita query params (não filters[]):
  //   pipeline_id, pipeline_stage_id, status, assigned_to,
  //   monetary_value_greater_than, monetary_value_less_than
  const params: Record<string, string> = {};
  switch (subfield) {
    case "pipelineId":
      params.pipeline_id = String(value);
      break;
    case "stageId":
      params.pipeline_stage_id = String(value);
      break;
    case "status":
      if (value !== "all") params.status = String(value);
      break;
    case "assignedTo":
      params.assigned_to = String(value);
      break;
    case "monetaryValue":
      if (op === "gt" || op === "gte") params.monetary_value_greater_than = String(value);
      else if (op === "lt" || op === "lte") params.monetary_value_less_than = String(value);
      else if (op === "between" && typeof value === "object" && value !== null && "from" in value) {
        const range = value as { from: number; to: number };
        params.monetary_value_greater_than = String(range.from);
        params.monetary_value_less_than = String(range.to);
      }
      break;
    default:
      // unsupported server-side
      break;
  }
  return params;
}
