/**
 * Tipos compartilhados pelo tool catalog do Sparkbot.
 *
 * Cada tool em tools/<categoria>.ts exporta um array de { def, handler }
 * que vai ser concatenado no registry final de tools/index.ts.
 */

import type { GHLClient } from "@/lib/ghl/client";
import type { ToolDefinition, ToolResult, RepIdentity } from "@/types/account-assistant";

export interface ToolContext {
  rep: RepIdentity;
  locationId: string; // active_location_id resolvido
  companyId: string;
  ghlClient: GHLClient;
}

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolEntry {
  def: ToolDefinition;
  handler: ToolHandler;
}

/**
 * IDs do GHL são alfanuméricos ~20 chars. Se o LLM mandar algo curto
 * (ex: "2", "pedro"), quase certamente inventou — rejeita antes de bater
 * na API e dá dica pra ele chamar search_contacts primeiro.
 */
export function validateGhlId(id: string, entityName: string): ToolResult | null {
  if (!id || typeof id !== "string" || id.length < 10 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return {
      status: "error",
      message: `${entityName}_id inválido: "${id}". IDs do GHL têm ~20 chars alfanuméricos (ex: 'ErpM2X8vR1U4IrRTZnKX'). Use search_contacts ou get_contact pra obter o ID real antes de chamar esta tool.`,
      retryable: false,
    };
  }
  return null;
}

/**
 * Valida ISO 8601. Datas passadas pelas tools devem ser ISO com Z (UTC) ou
 * offset (+HH:MM). Devolve null se OK, ou ToolResult de erro.
 */
export function validateIso8601(value: string, fieldName: string): ToolResult | null {
  if (!value) return { status: "error", message: `${fieldName} obrigatório`, retryable: false };
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    return {
      status: "error",
      message: `${fieldName} não é ISO 8601 válido: "${value}". Use formato '2026-04-28T10:00:00-05:00' ou '2026-04-28T15:00:00Z'.`,
      retryable: false,
    };
  }
  return null;
}

/** Helper pra extrair o ghl_user_id do rep na location ativa. */
export function getRepGhlUserId(ctx: ToolContext): string | undefined {
  return ctx.rep.ghl_users.find((u) => u.location_id === ctx.locationId)?.ghl_user_id;
}

/**
 * Wrap padrão pra tools que falham na chamada GHL: converte Error em
 * ToolResult de erro com mensagem expondo o body do GHL (útil pro LLM
 * tentar corrigir).
 */
export function ghlErrorToResult(err: unknown, action: string): ToolResult {
  const msg = err instanceof Error ? err.message : "Erro desconhecido";
  return {
    status: "error",
    message: `GHL rejeitou ${action}: ${msg}`,
    retryable: false,
  };
}
