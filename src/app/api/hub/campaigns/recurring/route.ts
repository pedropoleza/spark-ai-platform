/**
 * POST /api/hub/campaigns/recurring — cria campanha recorrente (Etapa 4.5).
 *
 * Pedro 2026-05-28: campanhas que rodam em cron (toda segunda 9am, etc).
 * Cada disparo cria um bulk_message_job filho. Timezone: do agente (D2,
 * timezone do active_hours.timezone). Filter Engine roda fresh a cada
 * disparo (refresh_segment_on_run=true default).
 *
 * Auth: getSession (admin OR rep dono do agente).
 * Body: { agent_id, label, tag, template, cron_expression, timezone?, per_run_cap?, delivery_channel? }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyRepByGhlUser } from "@/lib/account-assistant/identity";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { computeNextRunAt } from "@/lib/account-assistant/proactive/cron-evaluator";

export const maxDuration = 15;

const CreateSchema = z.object({
  agent_id: z.string().uuid(),
  label: z.string().min(1).max(100),
  tag: z.string().min(1).max(80),
  template: z.string().min(1).max(3000),
  cron_expression: z.string().min(7).max(40), // "0 9 * * 1" tem 9 chars
  timezone: z.string().min(3).max(60).optional(),
  per_run_cap: z.number().int().min(1).max(50000).optional(),
  delivery_channel: z.enum(["whatsapp_web_sms", "whatsapp_api"]).optional(),
  // Etapa 4.6 (Pedro 2026-05-28): controle de refresh do segmento.
  // Default true = re-executa Filter Engine fresh a cada disparo (comportamento
  // atual do runner). false = opt-in pra reuso de snapshot (NÃO implementado
  // hoje — follow-up; runner ignora o false e segue refresh).
  refresh_segment_on_run: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const parsed = CreateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse(
      "Dados inválidos: " + parsed.error.issues.map((i) => i.message).join("; "),
      400,
      "invalid_input",
    );
  }
  const body = parsed.data;

  // Sanity check do cron expression: 5 partes separadas por espaço.
  const parts = body.cron_expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return errorResponse(
      "Cron precisa ter 5 campos (min hora dia mês dow). Ex: '0 9 * * 1' = toda 2ª às 9h.",
      400,
      "invalid_cron",
    );
  }

  const supabase = createAdminClient();

  // Valida agente: pertence à location, é lead-facing, está active.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, type, location_id, status")
    .eq("id", body.agent_id)
    .eq("location_id", session.locationId)
    .maybeSingle();
  if (!agent) return errorResponse("Agente não encontrado", 404, "agent_not_found");
  const LEAD_TYPES = new Set(["sales_agent", "recruitment_agent", "custom_agent"]);
  if (!LEAD_TYPES.has(agent.type as string)) {
    return errorResponse("Só agentes lead-facing podem disparar campanhas recorrentes", 400, "wrong_agent_type");
  }
  if (agent.status !== "active") {
    return errorResponse("Ative o agente antes de criar uma campanha", 400, "agent_inactive");
  }

  // Resolve timezone: usa o fornecido OU lê do agent_configs.active_hours.timezone
  // OU do active_hours.tz (variantes do schema antigo) OU fallback New York.
  let timezone = body.timezone;
  if (!timezone) {
    const { data: config } = await supabase
      .from("agent_configs")
      .select("active_hours")
      .eq("agent_id", body.agent_id)
      .maybeSingle();
    type AH = { timezone?: string; tz?: string };
    const ah = (config?.active_hours || {}) as AH;
    timezone = ah.timezone || ah.tz || "America/New_York";
  }

  // Valida timezone (não trava se inválido — só registra warning).
  // computeNextRunAt vai retornar null se cron + timezone forem inválidos.
  const nextRunAt = computeNextRunAt(body.cron_expression, timezone, new Date());
  if (!nextRunAt) {
    return errorResponse(
      `Não consegui calcular o próximo disparo — confirme cron='${body.cron_expression}' e timezone='${timezone}'.`,
      400,
      "cron_unreachable",
    );
  }

  // Resolve rep_id pra ownership.
  const rep = await identifyRepByGhlUser({
    ghlUserId: session.userId,
    locationId: session.locationId,
    companyId: session.companyId,
  }).catch(() => null);
  if (!rep) {
    return errorResponse("Não consegui identificar seu rep_identity. Faça login novamente.", 500, "rep_not_found");
  }

  const { data: row, error } = await supabase
    .from("recurring_campaigns")
    .insert({
      rep_id: rep.id,
      location_id: session.locationId,
      agent_id: body.agent_id,
      label: body.label.trim(),
      cron_expression: body.cron_expression.trim(),
      timezone,
      filter_config: { tag: body.tag.trim() },
      message_template: body.template.trim(),
      delivery_channel: body.delivery_channel ?? "whatsapp_web_sms",
      refresh_segment_on_run: body.refresh_segment_on_run ?? true,
      enabled: true,
      next_run_at: nextRunAt.toISOString(),
      per_run_cap: body.per_run_cap ?? 1000,
    })
    .select("id, next_run_at")
    .single();

  if (error) {
    return errorResponse(error.message, 500, "db_error");
  }
  return NextResponse.json(
    { ok: true, id: row.id, next_run_at: row.next_run_at },
    { status: 201 },
  );
}
