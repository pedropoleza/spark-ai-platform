/**
 * Filter Engine — public API.
 *
 * Consumers (tools/index.ts, bulk-messages.ts, daily-briefing.ts) só
 * importam daqui. Modificações internas (compiler, executor) não
 * afetam consumers.
 *
 * H27 (review 2026-05-15) + H28 (bulk V2).
 */

// Types
export type {
  FilterExpression,
  FilterCondition,
  FilterableField,
  FilterOp,
  FilterValue,
  DateRange,
  FilterEntity,
  ContactResult,
  OpportunityResult,
  FilterResult,
  PlanStep,
  FilterExecutionContext,
  FilterExecutionOptions,
} from "./types";

export { FilterEngineError, isComposite, isLeaf } from "./types";

// Capabilities
export {
  getFieldCapability,
  isServerSideSupported,
  isAnyExecutable,
  listKnownFields,
  isOpCompatibleWithType,
  CONTACT_FIELDS,
  OPPORTUNITY_FIELDS,
} from "./capabilities";

// Cache (interno mas exposto pra invalidação manual / tests)
export {
  getPipelines,
  getCustomFields,
  getOpportunityCustomFields,
  getAllCustomFields,
  invalidateLocation,
  invalidateAll,
  getCacheStats,
} from "./cache";

export type { CachedPipeline, CachedCustomField } from "./cache";

// Resolvers
export { resolveAliases } from "./resolvers";

// Compiler + Executor (uso direto raro — geralmente via tools)
export { compile } from "./compiler";
export {
  executeContactsFilter,
  executeOpportunitiesFilter,
  countFilter,
} from "./executor";

// Audit
export { auditFilterExecution } from "./audit";

// Interpolation
export {
  interpolate,
  parseTemplate,
  buildCustomFieldResolver,
} from "./interpolator";
export type {
  InterpolationContext,
  InterpolationOptions,
  InterpolationResult,
} from "./interpolator";

// Disclaimers
export {
  computeDisclaimers,
  validateDisclaimerFlags,
  formatDisclaimersForWhatsApp,
  formatDisclaimersChecklist,
} from "./disclaimers";
export type { Disclaimer, DisclaimerKey, DisclaimerInput } from "./disclaimers";
