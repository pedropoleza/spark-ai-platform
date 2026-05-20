/**
 * Helper compartilhado: monta ToolContext + seleciona tools + chama runWithTools.
 *
 * Encapsula a parte DUPLICADA entre processor.ts (inbound) e
 * proactive/dispatcher.ts (proativo): montar toolCtx, selecionar os defs de tools
 * (all ou subset filtrado), criar executor e chamar runWithTools.
 *
 * O que NÃO vive aqui (fica em cada caller):
 *   - processor.ts: coherence gate, billing, persistência, detecção de falhas consecutivas
 *   - dispatcher.ts: billing, persistência em alert_state, delivery (simulated/real)
 *
 * P2 (review 2026-05-19): unificação do loop LLM duplicado — ver B1-arquitetura.md.
 */

import { GHLClient } from "@/lib/ghl/client";
import { runWithTools, type LLMMessage, type RunWithToolsOutput } from "../llm-client";
import {
  getAllToolDefinitions,
  getToolDefinitions,
  executeTool,
  type ToolContext,
} from "../tools";
import type { RepIdentity, RepInput } from "@/types/account-assistant";

/** Parâmetros comuns aos dois callers. */
export interface RunSparkbotTurnInput {
  /** Prompt de sistema já montado pelo caller. */
  systemPrompt: string;
  /** Messages no formato LLM (histórico + user message já incluídos pelo caller). */
  messages: LLMMessage[];
  /** Contexto de execução das tools. */
  toolCtx: ToolContext;
  /**
   * Modo de seleção de tools:
   *   - { kind: "all"; confirmationMode; disabledTools? } → getAllToolDefinitions (inbound)
   *   - { kind: "subset"; allowedNames; confirmationMode; disabledTools? } → getToolDefinitions (proativo)
   */
  toolSelection:
    | {
        kind: "all";
        confirmationMode: "always" | "medium_and_high" | "high_only";
        disabledTools?: string[];
      }
    | {
        kind: "subset";
        allowedNames?: string[] | null;
        confirmationMode: "always" | "medium_and_high" | "high_only";
        disabledTools?: string[];
      };
  model?: string;
  fallbackModel?: string | null;
}

/**
 * Constrói um ToolContext a partir dos campos essenciais. Helper pra evitar
 * repetir o mesmo object literal nos callers.
 */
export function buildToolCtx(params: {
  rep: RepIdentity;
  locationId: string;
  companyId: string;
  ghlClient: GHLClient;
  testSessionId?: string | null;
  confirmationMode?: "always" | "medium_and_high" | "high_only";
  enabledKbs?: string[];
  attachment?: RepInput | null;
}): ToolContext {
  return {
    rep: params.rep,
    locationId: params.locationId,
    companyId: params.companyId,
    ghlClient: params.ghlClient,
    testSessionId: params.testSessionId ?? null,
    confirmationMode: params.confirmationMode ?? "high_only",
    enabledKbs: params.enabledKbs,
    attachment: params.attachment ?? null,
  };
}

/**
 * Núcleo compartilhado: seleciona tools, monta executor, chama runWithTools.
 *
 * Retorna RunWithToolsOutput diretamente — cada caller continua responsável
 * pelo que faz com o resultado (coherence gate, billing, persistência, envio).
 */
export async function runSparkbotTurn(
  input: RunSparkbotTurnInput,
): Promise<RunWithToolsOutput> {
  const { systemPrompt, messages, toolCtx, toolSelection, model, fallbackModel } = input;

  const tools =
    toolSelection.kind === "all"
      ? getAllToolDefinitions(toolSelection.confirmationMode, toolSelection.disabledTools)
      : getToolDefinitions(
          toolSelection.allowedNames,
          toolSelection.confirmationMode,
          toolSelection.disabledTools,
        );

  return runWithTools({
    systemPrompt,
    messages,
    tools,
    executor: (name, args) => executeTool(name, args, toolCtx),
    model,
    fallbackModel,
  });
}
