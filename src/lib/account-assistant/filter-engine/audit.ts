/**
 * Filter Engine — audit log em filter_executions.
 *
 * Fire-and-forget (não bloqueia request). Falha de insert apenas loga
 * warning — engine continua funcionando.
 *
 * Schema migration 00063_filter_engine.sql.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type {
  FilterExpression,
  FilterEntity,
  FilterResult,
  FilterExecutionContext,
} from "./types";

export interface AuditInput {
  ctx: FilterExecutionContext;
  entity: FilterEntity;
  fel: FilterExpression;
  result: FilterResult<unknown>;
}

export function auditFilterExecution(input: AuditInput): void {
  (async () => {
    try {
      const supabase = createAdminClient();
      const planSteps = input.result.plan || [];
      const ghlCallsMade = planSteps.filter(
        (s) => s.action === "ghl_search" || s.action === "join_opp_to_contact",
      ).length;
      const clientSideApplied = planSteps.some((s) => s.action === "client_side_filter");

      await supabase.from("filter_executions").insert({
        rep_id: input.ctx.rep_id,
        agent_id: input.ctx.agent_id || null,
        location_id: input.ctx.location_id,
        entity: input.entity,
        fel_input: input.fel,
        plan_steps: planSteps,
        applied_aliases: input.result.applied_aliases || {},
        ghl_calls_made: ghlCallsMade,
        pages_fetched: input.result.pages_fetched || 0,
        total_returned: input.result.total_returned || 0,
        total_reported_by_ghl: input.result.total_reported_by_ghl || null,
        client_side_filter_applied: clientSideApplied,
        hit_safety_cap: input.result.hit_safety_cap || false,
        duration_ms: input.result.duration_ms || 0,
        status: input.result.status,
        error_message: input.result.message || null,
        consumer_tool: input.ctx.consumer_tool || null,
      });
    } catch (err) {
      console.warn(
        "[filter-engine audit] insert falhou:",
        err instanceof Error ? err.message : err,
      );
    }
  })();
}
