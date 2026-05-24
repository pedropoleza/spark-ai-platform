/**
 * Registry de fragmentos de módulo (Plataforma Modular, Fase 1).
 *
 * O catálogo no DB (`agent_modules`) LISTA os módulos (pra UI/composição); este
 * registry em código PROVÊ o conteúdo (o fragmento de prompt + futuramente as
 * tools). Cada entrada é uma variante (moduleKey × audience) — porque o módulo
 * `behavior` rep-facing (SparkBot) tem texto diferente do `behavior` lead-facing.
 *
 * Hoje só as variantes REP-FACING já decompostas do prompt do SparkBot. As
 * variantes LEAD-FACING (venda/recrutamento/custom) entram na Fase 2 — e é o
 * assembler que vai compor o prompt de um agente lead a partir daqui (em vez de
 * delegar, como o SparkBot faz hoje).
 *
 * `render` é `() => string[]` por enquanto (fragmentos estáticos). Quando
 * decompormos as seções COMPUTADAS (tones, memória, conversational), a assinatura
 * evolui pra `(ctx) => string[]` — aditivo.
 *
 * Plano: _planning/plataforma-modular/PLANO.md.
 */

import type { AgentAudience, ModuleCategory } from "@/types/agent-platform";
import { sparkbotBehaviorModuleLines } from "./behavior";
import { sparkbotSchedulingModuleLines } from "./scheduling";
import { sparkbotChannelModuleLines } from "./channel";
import { sparkbotKnowledgeModuleLines } from "./knowledge";

export interface ModuleFragment {
  key: string; // casa com agent_modules.key
  category: ModuleCategory;
  audience: AgentAudience;
  render: () => string[];
}

/** Variantes de fragmento já decompostas. (rep-facing do SparkBot, Fase 1.) */
export const MODULE_FRAGMENTS: ModuleFragment[] = [
  { key: "behavior", category: "behavior", audience: "rep", render: sparkbotBehaviorModuleLines },
  { key: "scheduling", category: "scheduling", audience: "rep", render: sparkbotSchedulingModuleLines },
  { key: "channel", category: "channel", audience: "rep", render: sparkbotChannelModuleLines },
  { key: "knowledge", category: "knowledge", audience: "rep", render: sparkbotKnowledgeModuleLines },
];

/** Acha o fragmento de um módulo numa audiência. */
export function getModuleFragment(key: string, audience: AgentAudience): ModuleFragment | undefined {
  return MODULE_FRAGMENTS.find((m) => m.key === key && m.audience === audience);
}

// Re-export pros consumidores atuais (prompt-builder do SparkBot faz spread direto).
export {
  sparkbotBehaviorModuleLines,
  sparkbotSchedulingModuleLines,
  sparkbotChannelModuleLines,
  sparkbotKnowledgeModuleLines,
};
