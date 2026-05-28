/**
 * POST /api/hub/campaigns — cria uma campanha de bulk-messages (Etapa 4.1 Commit B).
 *
 * Pedro 2026-05-28: primeira UI direta de criação no /hub. INSERT em
 * bulk_message_jobs com status='paused' por segurança — admin ativa via
 * SparkBot chat ("iniciar campanha <label>") usando as tools de bulk-management
 * que já existem. Próximo commit (4.1 C) trará botões pause/resume/cancel
 * direto na UI.
 *
 * Recipients NÃO são populados aqui — o cron runner já existente faz isso
 * quando o job vira 'running'.
 *
 * Auth: getSession (admin OR rep dono do agente).
 * Body: { agent_id, label, tag, template, interval_seconds? }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyRepByGhlUser } from "@/lib/account-assistant/identity";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export const maxDuration = 15;

const CreateCampaignSchema = z.object({
  agent_id: z.string().uuid(),
  label: z.string().min(1).max(100),
  tag: z.string().min(1).max(80),
  template: z.string().min(1).max(3000),
  interval_seconds: z.number().int().min(30).max(600).optional(),
  jitter_seconds: z.number().int().min(0).max(120).optional(),
  delivery_channel: z.enum(["whatsapp_web_sms", "whatsapp_api"]).optional(),
});

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const parsed = CreateCampaignSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse("Dados inválidos: " + parsed.error.issues.map((i) => i.message).join("; "), 400, "invalid_input");
  }
  const body = parsed.data;

  const supabase = createAdminClient();

  // Valida que o agente pertence à location E é lead-facing (sales/recruitment/custom).
  // SparkBot não dispara campanha — é assistente do rep.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, type, location_id, status")
    .eq("id", body.agent_id)
    .eq("location_id", session.locationId)
    .maybeSingle();
  if (!agent) return errorResponse("Agente não encontrado nesta sub-account", 404, "agent_not_found");
  const LEAD_TYPES = new Set(["sales_agent", "recruitment_agent", "custom_agent"]);
  if (!LEAD_TYPES.has(agent.type as string)) {
    return errorResponse("Só agentes lead-facing (Vendas/Recrutamento/Custom) podem disparar campanhas", 400, "wrong_agent_type");
  }
  if (agent.status !== "active") {
    return errorResponse("Ative o agente antes de criar uma campanha", 400, "agent_inactive");
  }

  // Resolve rep_id do usuário logado (bulk_message_jobs.rep_id NOT NULL).
  const rep = await identifyRepByGhlUser({
    ghlUserId: session.userId,
    locationId: session.locationId,
    companyId: session.companyId,
  }).catch(() => null);
  if (!rep) {
    return errorResponse("Não consegui identificar seu rep_identity. Faça login novamente.", 500, "rep_not_found");
  }

  const { data: job, error } = await supabase
    .from("bulk_message_jobs")
    .insert({
      rep_id: rep.id,
      location_id: session.locationId,
      agent_id: body.agent_id,
      filter_config: { tag: body.tag.trim() },
      message_template: body.template.trim(),
      variation_mode: "none", // MVP: sem variação; admin pode ajustar via SQL/tool
      interval_seconds: body.interval_seconds ?? 90,
      jitter_seconds: body.jitter_seconds ?? 30,
      delivery_channel: body.delivery_channel ?? "whatsapp_web_sms",
      respect_quiet_hours: true,
      // Pausada por segurança — admin ativa via SparkBot chat por enquanto.
      // Commit 4.1.C trará botões direto no /hub/campaigns/[id].
      status: "paused",
      label: body.label.trim(),
      total_contacts: 0,
    })
    .select("id")
    .single();

  if (error) {
    return errorResponse(error.message, 500, "db_error");
  }
  return NextResponse.json({ ok: true, id: job.id, status: "paused" }, { status: 201 });
}
