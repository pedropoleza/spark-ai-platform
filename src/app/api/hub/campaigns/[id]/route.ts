/**
 * PATCH /api/hub/campaigns/[id] — muda status da campanha (Etapa 4.1 Commit C).
 *
 * Pedro 2026-05-28: pause/resume/cancel direto na UI do hub (antes só via
 * SparkBot chat). Anti-IDOR: scope-check por location_id.
 *
 * Body: { status: "running" | "paused" | "cancelled" }
 *
 * Transições válidas:
 *   paused → running   (Iniciar/Retomar)
 *   running → paused   (Pausar)
 *   paused → cancelled (Cancelar)
 *   running → cancelled (Cancelar)
 *
 * Não-permitidas (silenciosamente recusadas):
 *   completed/failed/cancelled → qualquer coisa (estado final)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export const maxDuration = 10;

const PatchSchema = z.object({
  status: z.enum(["running", "paused", "cancelled"]),
});

const VALID_TRANSITIONS: Record<string, string[]> = {
  paused: ["running", "cancelled"],
  running: ["paused", "cancelled"],
};

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
    return errorResponse(
      "Status inválido (use running, paused ou cancelled)",
      400,
      "invalid_status",
    );
  }
  const target = parsed.data.status;

  const supabase = createAdminClient();
  const { data: job } = await supabase
    .from("bulk_message_jobs")
    .select("id, status, location_id")
    .eq("id", id)
    .eq("location_id", session.locationId)
    .maybeSingle();
  if (!job) return errorResponse("Campanha não encontrada", 404, "not_found");

  const current = job.status as string;
  const allowed = VALID_TRANSITIONS[current] || [];
  if (!allowed.includes(target)) {
    return errorResponse(
      `Não dá pra mudar de '${current}' pra '${target}' (estado final ou transição inválida)`,
      400,
      "invalid_transition",
    );
  }

  const update: Record<string, unknown> = { status: target };
  if (target === "cancelled") {
    update.completed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("bulk_message_jobs")
    .update(update)
    .eq("id", id);
  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({ ok: true, id, status: target });
}
