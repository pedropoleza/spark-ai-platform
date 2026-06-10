/**
 * Filter Engine — types públicos.
 *
 * FEL (Filter Expression Language) é uma DSL JSON usada por LLM pra
 * descrever filtros complexos sobre contatos/opportunities do Spark
 * Leads. A Engine compila FEL pra chamadas GHL otimizadas + fallback
 * client-side quando GHL não suporta server-side filter.
 *
 * Princípios:
 *  - AND / OR / NOT aninhados (sem limite arbitrário de profundidade,
 *    mas validator caps em 5 níveis pra evitar runaway)
 *  - Aliases automáticos (M3 → stage UUID, 'self' → rep ghl_user_id)
 *  - Capability matrix: cada par (field, operator) tem suporte GHL
 *    documentado + fallback client-side
 *  - Paginação ilimitada (cap defensivo 5000 = 50 pages × 100)
 *  - Audit log em filter_executions
 *
 * H27 (review 2026-05-15, plan filter-engine-and-bulk-v2.md).
 */

// =====================================================================
// FilterExpression — DSL recursiva
// =====================================================================

export type FilterExpression =
  | { all: FilterExpression[] }   // AND lógico
  | { any: FilterExpression[] }   // OR lógico
  | { not: FilterExpression }     // NOT (inverte)
  | FilterCondition;              // folha

/** Folha — condição atômica. */
export interface FilterCondition {
  field: FilterableField;
  op: FilterOp;
  value: FilterValue;
}

/** Type guard pra distinguir folha vs composição. */
export function isComposite(
  expr: FilterExpression,
): expr is { all: FilterExpression[] } | { any: FilterExpression[] } | { not: FilterExpression } {
  return (
    typeof expr === "object" &&
    expr !== null &&
    ("all" in expr || "any" in expr || "not" in expr)
  );
}

export function isLeaf(expr: FilterExpression): expr is FilterCondition {
  return !isComposite(expr) && "field" in expr;
}

// =====================================================================
// FilterableField — campos que FEL aceita filtrar
// =====================================================================
//
// Naming: usa nomes GHL nativos pra reduzir confusão (firstName, não
// first_name; assignedTo, não assigned_to; etc). Snake_case dos consumers
// é traduzido pelo schema das tools.

export type FilterableField =
  // === Standard contact fields ===
  | "firstName"
  | "lastName"
  | "fullName"          // alias pra busca cross firstName+lastName
  | "email"
  | "phone"
  | "address1"
  | "city"
  | "state"
  | "postalCode"
  | "country"
  | "timezone"
  | "companyName"
  | "dateOfBirth"       // formato YYYY-MM-DD ou MM-DD pra month_day_eq
  | "source"
  | "tags"              // array — usa op `contains`
  | "assignedTo"        // user ghl_user_id; alias 'self' resolvido
  | "dateAdded"
  | "dateUpdated"
  | "lastActivity"
  | "dnd"               // boolean
  // === Opportunity joined fields ===
  // Cada um faz join via contact_id; quando filter inclui ANY
  // opportunity field, engine roda opportunities/search primeiro pra
  // resolver contact_ids elegíveis e depois intersect com contact filter.
  | "opportunity.pipelineId"
  | "opportunity.stageId"
  | "opportunity.stageName"        // alias resolvido via pipelines cache
  | "opportunity.status"           // open|won|lost|abandoned|all
  | "opportunity.monetaryValue"
  | "opportunity.assignedTo"
  | "opportunity.createdAt"
  | "opportunity.updatedAt"
  | "opportunity.lastStageChangeAt"
  // === Custom fields ===
  // Aceita ambos: slug (`customField.aap_range`) E id (`customField.{id}`).
  // NB-9 (review 2026-06-10): resolver tenta SLUG primeiro; só trata como id
  // se bater num cf.id real da location (antes era heurístico de shape frágil).
  | `customField.${string}`;

// =====================================================================
// FilterOp — operadores
// =====================================================================

export type FilterOp =
  // Comparação direta
  | "eq" | "neq"
  // Numéricos / temporais
  | "gt" | "gte" | "lt" | "lte"
  | "between"          // value = [min, max] ou DateRange
  | "before" | "after" // só datas
  | "date_eq"          // YYYY-MM-DD igual
  | "month_day_eq"     // só MM-DD (ignora ano) — útil pra aniversários
  // String
  | "contains" | "not_contains"
  | "starts_with" | "ends_with"
  // Conjuntos
  | "in" | "not_in"
  // Presença
  | "exists" | "not_exists";

// =====================================================================
// FilterValue — payload do operador
// =====================================================================

export type FilterValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | DateRange
  | null;            // pra exists/not_exists

export interface DateRange {
  from: string;       // ISO 8601 ou YYYY-MM-DD
  to: string;
}

// =====================================================================
// FilterEntity — o que está sendo filtrado
// =====================================================================

export type FilterEntity = "contacts" | "opportunities";

// =====================================================================
// Result types — o que a Engine devolve
// =====================================================================

export interface ContactResult {
  id: string;
  name: string | null;
  firstName?: string;
  lastName?: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  dateOfBirth?: string | null;
  dateAdded?: string | null;
  dateUpdated?: string | null;
  lastActivity?: string | null;
  assignedTo?: string | null;
  customFields?: Array<{ id: string; key?: string; value: string }>;
  /** Pode ter opps joined se include_opportunity=true */
  opportunities?: Array<{
    id: string;
    name?: string;
    pipelineId: string;
    stageId: string;
    monetaryValue: number;
    status: string;
  }>;
}

export interface OpportunityResult {
  id: string;
  name: string | null;
  monetaryValue: number;
  status: string;
  pipelineId: string;
  stageId: string;
  contactId: string;
  contactName?: string | null;
  assignedTo?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastStageChangeAt?: string;
  /**
   * Pedro 2026-05-15: opps têm `customFields` array embedded no response.
   * GHL retorna valor em campo diferente conforme dataType:
   *   TEXT → fieldValueString
   *   NUMERICAL/MONETARY → fieldValueNumber
   *   DATE → fieldValueDate (timestamp ms, ex: 1777766400000)
   *   MULTIPLE_OPTIONS/CHECKBOX → fieldValueArray
   *   SINGLE_OPTIONS/RADIO → fieldValue (string)
   * `type` indica o dataType.
   */
  customFields?: Array<{
    id: string;
    type?: string;
    fieldValue?: string | number | string[];
    fieldValueString?: string;
    fieldValueNumber?: number;
    fieldValueDate?: number;     // timestamp ms
    fieldValueArray?: string[];
  }>;
}

/** Resultado de uma execução FEL. */
export interface FilterResult<T> {
  status: "ok" | "error" | "not_found";
  items?: T[];
  total_returned?: number;
  /** GHL meta.total quando disponível (ground truth) */
  total_reported_by_ghl?: number;
  /** true = exauriu fonte naturalmente; false = hit cap defensivo */
  complete?: boolean;
  pages_fetched?: number;
  /** Plan textual do que foi feito (audit + debug) */
  plan?: PlanStep[];
  /** Aliases resolvidos durante compile */
  applied_aliases?: Record<string, string>;
  /** Filtros aplicados client-side (não suportados server) */
  client_side_filters?: string[];
  /** Warning quando hit cap defensivo */
  hit_safety_cap?: boolean;
  /** ms total da execução */
  duration_ms?: number;
  /** ID do row em filter_executions */
  execution_id?: string;
  /** Quando status=error */
  message?: string;
  /** Quando status=error */
  retryable?: boolean;
}

/** Passo do plano de execução (audit). */
export interface PlanStep {
  step: number;
  action: "ghl_search" | "ghl_pipelines_resolve" | "ghl_custom_fields_resolve" |
          "client_side_filter" | "join_opp_to_contact" | "intersection" | "union" | "dedup";
  detail: string;
  ghl_endpoint?: string;
  ghl_params?: Record<string, unknown>;
  result_count?: number;
  duration_ms?: number;
}

// =====================================================================
// Execution context
// =====================================================================

export interface FilterExecutionContext {
  rep_id: string;
  rep_phone?: string;
  location_id: string;
  company_id: string;
  agent_id?: string;
  ghl_client: import("@/lib/ghl/client").GHLClient;
  /** Tool que chamou a engine (audit) */
  consumer_tool?: string;
  /** Aliases do rep_profile.aliases injetados antes de executar */
  rep_aliases?: Record<string, string>;
}

// =====================================================================
// Execution options
// =====================================================================

export interface FilterExecutionOptions {
  /** Soft cap no retorno. Sem efeito em total_reported_by_ghl. Default 5000. */
  limit?: number;
  /** Campos a devolver (subset). Default = todos básicos. */
  fields?: string[];
  /** Pra contacts: joinar opps de cada contato? Default false. */
  include_opportunity?: boolean;
  /** Sort */
  sort?: { field: FilterableField; direction: "asc" | "desc" };
  /** Pular cache (pra debug) */
  bypass_cache?: boolean;
  /** Não escreve audit log (testes) */
  skip_audit?: boolean;
}

// =====================================================================
// Error
// =====================================================================

export class FilterEngineError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_FEL"
      | "UNSUPPORTED_FIELD"
      | "UNSUPPORTED_OPERATOR"
      | "INVALID_VALUE"
      | "ALIAS_NOT_FOUND"
      | "ALIAS_AMBIGUOUS"
      | "GHL_ERROR"
      | "DEPTH_LIMIT"
      | "CAP_HIT",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FilterEngineError";
  }
}
