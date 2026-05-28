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
 *
 * Etapa 4.4 (Pedro 2026-05-28): quando a transição é paused → running E o
 * job ainda não tem recipients populados, chama o campaign-populator pra
 * resolver contatos via Filter Engine e popular bulk_message_recipients +
 * (se has_sequence) bulk_message_sequence_state. Idempotente — pause/resume
 * múltiplas vezes não duplica fila. maxDuration sobe pra 30s pra acomodar
 * filter+insert de até ~5k contatos.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { populateCampaignRecipients } from "@/lib/account-assistant/proactive/campaign-populator";

export const maxDuration = 30;

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

  // Etapa 4.4: quando paused → running, popula recipients (+ sequence_state
  // se for multi-toque). Idempotente — re-resume noop se já populado.
  let populated: { populated: number; state_created: number; reason?: string } | null = null;
  if (current === "paused" && target === "running") {
    try {
      const popResult = await populateCampaignRecipients(id);
      populated = {
        populated: popResult.populated,
        state_created: popResult.state_created,
        reason: popResult.reason,
      };
      // Se populator falhou (ex: location não sincronizada), reverte job pra
      // paused pra admin não ficar achando que vai disparar.
      if (!popResult.ok && popResult.reason !== "already_populated") {
        await supabase
          .from("bulk_message_jobs")
          .update({ status: "paused" })
          .eq("id", id);
        return errorResponse(
          `Não consegui montar a lista: ${popResult.reason}. Campanha voltou pra pausa — verifique a tag.`,
          400,
          "populate_failed",
        );
      }
    } catch (popErr) {
      console.warn(
        `[campaigns/PATCH] populator falhou pra job ${id}:`,
        popErr instanceof Error ? popErr.message.slice(0, 200) : popErr,
      );
      // Não rollback agressivo nesse path — populator pode ter inserido parte;
      // admin pode pausar manualmente se quiser.
    }
  }

  return NextResponse.json({ ok: true, id, status: target, populated });
}
