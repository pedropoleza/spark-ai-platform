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
  /**
   * F4 (cost-reduction 2026-06) — revertido em A1 (2026-07-20): nenhum caller passa
   * mais "1h" (ver llm-client.ts RunWithToolsInput.cacheTtl). Mantido pro futuro.
   */
  cacheTtl?: "5m" | "1h";
  /** A4 (2026-07-20): desliga cache_control — disparo 1x/dia nunca relê o cache. */
  disableCache?: boolean;
  /** A2 (2026-07-20): tools terminais (ver llm-client.ts RunWithToolsInput.terminalTools). */
  terminalTools?: Array<{
    name: string;
    validate?: (input: Record<string, unknown>) => boolean;
  }>;
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

// F58: tools de CRIAÇÃO idempotentes — repeat exato no mesmo turno é barrado.
// (send_message_to_contact fica de fora: 2 envios podem ser intencionais.)
const IDEMPOTENT_CREATE_TOOLS = new Set<string>([
  "create_task",
  "create_note",
  "create_appointment",
  "schedule_reminder",
  "schedule_message_to_contact",
  "create_contact",
]);

/** JSON estável (chaves ordenadas) pra assinar args de tool no dedup F58. */
function stableArgs(args: unknown): string {
  try {
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const obj = args as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return JSON.stringify(keys.map((k) => [k, obj[k]]));
    }
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
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
  const { systemPrompt, messages, toolCtx, toolSelection, model, fallbackModel, cacheTtl, disableCache, terminalTools } = input;

  const tools =
    toolSelection.kind === "all"
      ? getAllToolDefinitions(toolSelection.confirmationMode, toolSelection.disabledTools)
      : getToolDefinitions(
          toolSelection.allowedNames,
          toolSelection.confirmationMode,
          toolSelection.disabledTools,
        );

  // F58 (Fix bug observado em prod 2026-06-04 — caso Soraia): dedup de WRITE
  // idêntico repetido na MESMA virada. No tool-loop multi-iteração, o LLM às
  // vezes re-chama uma tool de CRIAÇÃO com args idênticos numa iteração seguinte
  // (gap ~2s) → criava 2 tasks GHL iguais (7 reminders duplicados pra Soraia).
  // Pra essas tools, se a assinatura (name+args) já rodou COM SUCESSO neste
  // turno, devolve o MESMO resultado (mesmo id) sem re-executar. Idempotente:
  // writes com args diferentes passam normalmente; só o repeat exato é barrado.
  const writeCache = new Map<string, Awaited<ReturnType<typeof executeTool>>>();
  const dedupExecutor = async (
    name: string,
    args: Parameters<typeof executeTool>[1],
  ): Promise<Awaited<ReturnType<typeof executeTool>>> => {
    if (!IDEMPOTENT_CREATE_TOOLS.has(name)) return executeTool(name, args, toolCtx);
    const sig = `${name}::${stableArgs(args)}`;
    const cached = writeCache.get(sig);
    if (cached) {
      const c = cached as { data?: Record<string, unknown> };
      console.warn(`[run-sparkbot-turn] F58 dedup: ${name} idêntico repetido no turno — devolvendo resultado anterior`);
      return { ...cached, data: { ...(c.data || {}), deduped_in_turn: true } } as Awaited<ReturnType<typeof executeTool>>;
    }
    const r = await executeTool(name, args, toolCtx);
    if ((r as { status?: string }).status === "ok") writeCache.set(sig, r);
    return r;
  };

  return runWithTools({
    systemPrompt,
    messages,
    tools,
    executor: dedupExecutor,
    model,
    fallbackModel,
    cacheTtl,
    disableCache,
    terminalTools,
  });
}
