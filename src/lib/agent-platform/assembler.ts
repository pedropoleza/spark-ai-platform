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
import type { AgentAudience } from "@/types/agent-platform";

/** Motor unificado ligado? Default OFF. Liga o CAMINHO via assembler (output idêntico na Fase 1). */
export function isUnifiedMotorEnabled(): boolean {
  const v = (process.env.AGENT_MOTOR_UNIFIED || "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

export interface AssembleSystemPromptInput {
  templateKey: string; // 'sparkbot' | 'sales' | 'recruitment' | custom...
  audience: AgentAudience;
  /** Args legados do SparkBot — usados na delegação de paridade (template 'sparkbot'). */
  sparkbotArgs?: BuildPromptArgs;
}

/**
 * Monta o system prompt de um agente a partir do template (+ módulos, Fase 2+).
 *
 * FASE 1: 'sparkbot' delega ao builder existente (paridade). Demais templates
 * ainda não suportados (Fase 2 — lead-facing).
 */
export function assembleSystemPrompt(input: AssembleSystemPromptInput): string {
  switch (input.templateKey) {
    case "sparkbot": {
      if (!input.sparkbotArgs) {
        throw new Error("assembleSystemPrompt('sparkbot') exige sparkbotArgs");
      }
      // Paridade total na Fase 1. A decomposição em módulos será introduzida
      // aqui depois, sempre mantendo `scripts/test-motor-parity.ts` verde.
      return buildSparkbotSystemPrompt(input.sparkbotArgs);
    }
    default:
      throw new Error(
        `assembleSystemPrompt: template '${input.templateKey}' ainda não suportado ` +
          `(lead-facing entra na Fase 2).`,
      );
  }
}
