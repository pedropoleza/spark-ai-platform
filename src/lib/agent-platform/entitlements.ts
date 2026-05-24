/**
 * Gate de entitlement da Plataforma Modular (Fase 0, D6).
 *
 * Modelo de negócio: SparkBot (account_assistant, rep-facing) é INCLUSO/grátis;
 * venda/recrutamento/custom (lead-facing) são upsell PAGO — exigem entitlement
 * ativo na location, OU um admin liberando (liberação manual).
 *
 * SEGURANÇA DE ROLLOUT: a enforcement é GATED por env `AGENT_ENTITLEMENTS_ENFORCED`
 * (default OFF). Com a flag desligada, o gate SEMPRE libera mas LOGA o que
 * aconteceria (log-first) — assim a gente observa em prod antes de cortar acesso.
 * Mesma disciplina das outras features (PROACTIVE_EVENTS_ENABLED etc).
 *
 * Plano: _planning/plataforma-modular/PLANO.md. Repo: agent-platform.repo.ts.
 */

import { getActiveEntitlement } from "@/lib/repositories/agent-platform.repo";
import type { AgentCapability } from "@/types/agent-platform";

/** Enforcement ligada? Default OFF (log-first) até a gente validar em prod. */
export function isEntitlementsEnforced(): boolean {
  const v = (process.env.AGENT_ENTITLEMENTS_ENFORCED || "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

/**
 * Tipo de agente → capacidade paga. account_assistant (SparkBot) retorna null
 * = incluso/grátis (não precisa de entitlement).
 */
export function capabilityForAgentType(agentType: string): AgentCapability | null {
  switch (agentType) {
    case "sales_agent":
      return "sales_agent";
    case "recruitment_agent":
      return "recruitment_agent";
    case "custom_agent":
      return "custom_agent";
    case "account_assistant":
      return null; // rep-facing, incluso
    default:
      return null;
  }
}

export interface EntitlementDecision {
  /** Pode prosseguir? (com flag OFF, sempre true — log-first.) */
  allowed: boolean;
  /** A enforcement está ligada? */
  enforced: boolean;
  capability: AgentCapability | null;
  /** included_free | admin_bypass | entitled | no_entitlement | log_only_would_block */
  reason: string;
}

/**
 * Decisão PURA (sem IO) — testável exaustivamente.
 *
 * - capability null (SparkBot / rep-facing): SEMPRE liberado (incluso).
 * - isAdmin: sempre liberado (setup / liberação manual).
 * - flag OFF: allowed=true sempre (log-first), reason distingue entitled vs
 *   log_only_would_block.
 * - flag ON: liberado só com entitlement ativo.
 */
export function decideEntitlement(params: {
  capability: AgentCapability | null;
  isAdmin: boolean;
  hasActiveEntitlement: boolean;
  enforced: boolean;
}): EntitlementDecision {
  const { capability, isAdmin, hasActiveEntitlement, enforced } = params;
  if (capability === null) {
    return { allowed: true, enforced, capability, reason: "included_free" };
  }
  if (isAdmin) {
    return { allowed: true, enforced, capability, reason: "admin_bypass" };
  }
  if (!enforced) {
    return {
      allowed: true,
      enforced,
      capability,
      reason: hasActiveEntitlement ? "entitled" : "log_only_would_block",
    };
  }
  return {
    allowed: hasActiveEntitlement,
    enforced,
    capability,
    reason: hasActiveEntitlement ? "entitled" : "no_entitlement",
  };
}

/**
 * Decide se uma location pode criar/usar um agente de dado tipo (wrapper com IO).
 *
 * - account_assistant (SparkBot): SEMPRE liberado (incluso).
 * - lead-facing (sales/recruitment/custom): liberado se `isAdmin` OU houver
 *   entitlement ativo (não-expirado).
 * - Flag OFF: retorna allowed=true sempre, mas loga quando BLOQUEARIA — não
 *   quebra nada até ligarmos a enforcement.
 */
export async function checkAgentEntitlement(params: {
  locationId: string;
  agentType: string;
  isAdmin?: boolean;
}): Promise<EntitlementDecision> {
  const enforced = isEntitlementsEnforced();
  const capability = capabilityForAgentType(params.agentType);

  // Short-circuit: incluso ou admin não precisam consultar DB.
  if (capability === null || params.isAdmin) {
    return decideEntitlement({
      capability,
      isAdmin: !!params.isAdmin,
      hasActiveEntitlement: false,
      enforced,
    });
  }

  const ent = await getActiveEntitlement(params.locationId, capability);
  if (!enforced && !ent) {
    console.warn(
      `[entitlements] (log-only — flag OFF) location=${params.locationId} ` +
        `capability=${capability}: SEM entitlement ativo — BLOQUEARIA se enforced.`,
    );
  }
  return decideEntitlement({
    capability,
    isAdmin: false,
    hasActiveEntitlement: !!ent,
    enforced,
  });
}
