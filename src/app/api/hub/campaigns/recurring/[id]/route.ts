/**
 * PATCH/DELETE /api/hub/campaigns/recurring/[id] (Etapa 4.5).
 *
 * PATCH: enable/disable. Quando enable=true reseta next_run_at (re-computa
 * baseado no cron+tz salvos). Quando enable=false só seta enabled=false.
 *
 * DELETE: remove a recurring_campaigns row. Jobs filhos JÁ criados ficam —
 * são independentes (admin pode cancelar via /hub/campaigns).
 *
 * Anti-IDOR: scope-check por location_id.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { computeNextRunAt } from "@/lib/account-assistant/proactive/cron-evaluator";

export const maxDuration = 10;

const PatchSchema = z.object({
  enabled: z.boolean(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return unauthorized();

  const { id } = await params;
  if (!id) return errorResponse("ID inválido", 400, "invalid_id");

  const parsed = PatchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse("Body inválido (precisa de { enabled: bool })", 400, "invalid_input");
  }

  const supabase = createAdminClient();
  const { data: row } = await supabase
    .from("recurring_campaigns")
    .select("id, cron_expression, timezone, location_id")
    .eq("id", id)
    .eq("location_id", session.locationId)
    .maybeSingle();
  if (!row) return errorResponse("Recorrência não encontrada", 404, "not_found");

  const update: Record<string, unknown> = {
    enabled: parsed.data.enabled,
    updated_at: new Date().toISOString(),
  };

  if (parsed.data.enabled) {
    // Re-computa next_run_at quando reativa.
    const next = computeNextRunAt(
      row.cron_expression as string,
      row.timezone as string,
      new Date(),
    );
    update.next_run_at = next?.toISOString() ?? null;
  }

  const { error } = await supabase
    .from("recurring_campaigns")
    .update(update)
    .eq("id", id);
  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({
    ok: true,
    id,
    enabled: parsed.data.enabled,
    next_run_at: update.next_run_at ?? null,
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return unauthorized();

  const { id } = await params;
  if (!id) return errorResponse("ID inválido", 400, "invalid_id");

  const supabase = createAdminClient();
  // Scope-check + delete em 1 query
  const { data: deleted, error } = await supabase
    .from("recurring_campaigns")
    .delete()
    .eq("id", id)
    .eq("location_id", session.locationId)
    .select("id");
  if (error) return errorResponse(error.message, 500, "db_error");
  if (!deleted || deleted.length === 0) {
    return errorResponse("Recorrência não encontrada", 404, "not_found");
  }
  return NextResponse.json({ ok: true, id });
}
