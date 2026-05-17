/**
 * Conversational UX layer — public exports (H29 + H30 + H31).
 *
 * Pedro 2026-05-15: pacote unificado de UX. Importável por:
 *   - prompt-builder.ts (guides + style hints + templates)
 *   - processor.ts (turn-context injection + voice detection)
 *   - tools/* (smart defaults + disambiguation + recovery)
 */

// Templates
export { TEMPLATE_DOCS, styleHintForRep } from "./templates";

// Turn context
export {
  createTurnContext,
  registerEntity,
  registerSearch,
  registerWrite,
  recordQuestion,
  questionCount,
  recordBulkChoice,
  autoRegisterFromToolResult,
  renderTurnContextForPrompt,
} from "./turn-context";
export type { TurnContextState, ResolvedEntity } from "./turn-context";

// Next-step suggestions
export {
  NEXT_STEP_MAP,
  getTopSuggestion,
  getAllSuggestions,
  renderSuggestionForPrompt,
} from "./next-steps";
export type { NextStepSuggestion } from "./next-steps";

// Smart defaults
export {
  computeSmartDefaults,
  renderSmartDefaultsForPrompt,
} from "./smart-defaults";
export type { SmartDefaults } from "./smart-defaults";

// Voice detector
export { detectRepStyle } from "./voice-detector";
export type { RepStyle } from "./voice-detector";

// Disambiguation
export {
  rankCandidates,
  disambiguate,
  renderDisambiguationOptions,
} from "./disambiguation";
export type {
  RankableCandidate,
  RankedCandidate,
  DisambiguationResult,
} from "./disambiguation";

// Error recovery
export {
  ERROR_RECOVERY_MAP,
  detectRecoveryPlan,
  ERROR_RECOVERY_PROMPT_GUIDE,
} from "./error-recovery";
export type { RecoveryPlan } from "./error-recovery";

// Multi-action
export { MULTI_ACTION_PROMPT_GUIDE } from "./multi-action";

// Silence recovery (4.3)
export {
  detectSilenceGap,
  renderSilenceRecoveryForPrompt,
} from "./silence-recovery";
export type { SilenceGapInfo, MessageForSilenceCheck } from "./silence-recovery";
