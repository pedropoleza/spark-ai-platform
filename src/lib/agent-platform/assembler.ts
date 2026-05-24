/**
 * Motor Unificado — Assembler de system prompt (Plataforma Modular, Fase 1).
 *
 * Objetivo: TODO agente (SparkBot rep-facing + venda/recrut/custom lead-facing)
 * monta seu system prompt por aqui, a partir de template + módulos.
 *
 * ESTRATÉGIA DE PARIDADE (enterprise — paridade primeiro, refactor depois):
 * na Fase 1 o template 'sparkbot' DELEGA pro builder existente
 * (`buildSparkbotSystemPrompt`) → output byte-a-byte idêntico ao de hoje. A
 * decomposição do prompt em módulos entra DEPOIS, incremental, cada extração
 * guardada por `scripts/test-motor-parity.ts` (que exige assembler === legado).
 * Templates lead-facing (sales/recruitment) entram na Fase 2.
 *
 * Rollout: gated por `AGENT_MOTOR_UNIFIED` (default OFF). Com a flag ligada, o
 * processor passa a montar o prompt do SparkBot por aqui — mas como delega, o
 * comportamento é idêntico. A flag separa o CAMINHO, não o comportamento (ainda).
 *
 * Plano: _planning/plataforma-modular/PLANO.md.
 */

import { buildSparkbotSystemPrompt, type BuildPromptArgs } from "@/lib/account-assistant/prompt-builder";
import { buildSystemPrompt as buildLeadSystemPrompt, type PromptContext } from "@/lib/ai/sales-prompt-builder";
import type { AgentAudience } from "@/types/agent-platform";

/** Motor unificado ligado? Default OFF. Liga o CAMINHO via assembler (output idêntico na Fase 1). */
export function isUnifiedMotorEnabled(): boolean {
  const v = (process.env.AGENT_MOTOR_UNIFIED || "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

export interface AssembleSystemPromptInput {
  templateKey: string; // 'sparkbot' | 'sales' | 'recruitment' | custom...
  audience: AgentAudience;
  /** Args legados do SparkBot — usados na delegação de paridade (template 'sparkbot', rep-facing). */
  sparkbotArgs?: BuildPromptArgs;
  /** Contexto legado de venda/recrut — usado na delegação (templates lead-facing). */
  leadArgs?: PromptContext;
}

/**
 * Monta o system prompt de um agente a partir do template (+ módulos).
 *
 * PARIDADE PRIMEIRO: cada template delega ao builder legado correspondente
 * (output byte-a-byte idêntico), guardado por testes de paridade. A composição
 * a partir dos módulos do registry entra incremental, sempre parity-guarded.
 *  - 'sparkbot' (rep-facing) → buildSparkbotSystemPrompt (test-motor-parity.ts)
 *  - 'sales' / 'recruitment' (lead-facing) → buildLeadSystemPrompt (test-sales-parity.ts)
 *  - custom lead-facing → herda do template base (sales/recruitment) por ora.
 */
export function assembleSystemPrompt(input: AssembleSystemPromptInput): string {
  switch (input.templateKey) {
    case "sparkbot": {
      if (!input.sparkbotArgs) {
        throw new Error("assembleSystemPrompt('sparkbot') exige sparkbotArgs");
      }
      return buildSparkbotSystemPrompt(input.sparkbotArgs);
    }
    case "sales":
    case "recruitment": {
      if (!input.leadArgs) {
        throw new Error(`assembleSystemPrompt('${input.templateKey}') exige leadArgs`);
      }
      // Lead-facing já é modular por dentro (section functions). Delega pro
      // builder legado (paridade); o registry mapeia as sections pros módulos.
      return buildLeadSystemPrompt(input.leadArgs);
    }
    default:
      throw new Error(
        `assembleSystemPrompt: template '${input.templateKey}' ainda não suportado.`,
      );
  }
}

/** Mapeia agent.type → templateKey do assembler. */
export function templateKeyForAgentType(agentType: string): string {
  switch (agentType) {
    case "account_assistant":
      return "sparkbot";
    case "sales_agent":
      return "sales";
    case "recruitment_agent":
      return "recruitment";
    default:
      return agentType;
  }
}
