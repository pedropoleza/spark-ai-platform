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
 * Body: { agent_id, label, tag, template, interval_seconds?, sequence_steps? }
 *
 * Etapa 4.4 (Pedro 2026-05-28): aceita opcionalmente `sequence_steps[]` pra
 * campanha multi-toque. Se presente, o `template` raiz é ignorado a favor do
 * step 1; o array é gravado em `bulk_message_sequences` rows. Step 1 SEMPRE
 * tem delay_days=0 (dispara junto com o job ativando); steps 2+ exigem
 * delay_days >= 1. Runner (sequence-runner.ts) avança state quando o delay
 * vence. Pause-on-reply default true por step.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyRepByGhlUser } from "@/lib/account-assistant/identity";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export const maxDuration = 15;

// Etapa 4.4: schema de step. delay_days é dias após o step anterior.
// Step 1: SEMPRE delay_days=0 (sai junto com a ativação do job).
// Steps 2-10: delay_days 1-90.
const SequenceStepSchema = z.object({
  template: z.string().min(1).max(3000),
  delay_days: z.number().int().min(0).max(90),
  pause_on_reply: z.boolean().optional().default(true),
});

const CreateCampaignSchema = z.object({
  agent_id: z.string().uuid(),
  label: z.string().min(1).max(100),
  tag: z.string().min(1).max(80),
  template: z.string().min(1).max(3000),
  interval_seconds: z.number().int().min(30).max(600).optional(),
  jitter_seconds: z.number().int().min(0).max(120).optional(),
  delivery_channel: z.enum(["whatsapp_web_sms", "whatsapp_api"]).optional(),
  // Opcional. Se presente: 1-10 steps. Step[0] vira a msg-inicial (delay=0);
  // steps[1..] disparam após delay_days do step anterior.
  sequence_steps: z.array(SequenceStepSchema).min(1).max(10).optional(),
});

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const parsed = CreateCampaignSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse("Dados inválidos: " + parsed.error.issues.map((i) => i.message).join("; "), 400, "invalid_input");
  }
  const body = parsed.data;

  // Etapa 4.4: validação extra de sequence_steps. Schema-level só garante 1-10 e
  // delay_days 0-90. Aqui forçamos:
  //   - step 1 (index 0) tem delay_days=0 (sai junto com ativação).
  //   - steps 2+ (index 1..) têm delay_days >= 1 (senão dispara junto = sem sentido).
  if (body.sequence_steps && body.sequence_steps.length > 0) {
    if (body.sequence_steps[0].delay_days !== 0) {
      return errorResponse("O primeiro passo da sequência precisa ter delay 0 (sai junto com a ativação).", 400, "invalid_sequence_step_1");
    }
    for (let i = 1; i < body.sequence_steps.length; i++) {
      if (body.sequence_steps[i].delay_days < 1) {
        return errorResponse(`Passo ${i + 1} precisa ter delay de pelo menos 1 dia (senão dispara junto com o anterior).`, 400, "invalid_sequence_step_delay");
      }
    }
  }

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

  // Etapa 4.4: se tem sequência, o template-raiz do job vira o template do step 1
  // (compatibilidade com runner antigo que lê message_template do job direto).
  // Steps adicionais ficam só em bulk_message_sequences.
  const rootTemplate = body.sequence_steps?.[0]?.template?.trim() || body.template.trim();
  const isSequence = !!(body.sequence_steps && body.sequence_steps.length > 1);

  const { data: job, error } = await supabase
    .from("bulk_message_jobs")
    .insert({
      rep_id: rep.id,
      location_id: session.locationId,
      agent_id: body.agent_id,
      filter_config: { tag: body.tag.trim() },
      message_template: rootTemplate,
      variation_mode: "none", // MVP: sem variação; admin pode ajustar via SQL/tool
      interval_seconds: body.interval_seconds ?? 90,
      jitter_seconds: body.jitter_seconds ?? 30,
      delivery_channel: body.delivery_channel ?? "whatsapp_web_sms",
      respect_quiet_hours: true,
      // Pausada por segurança — admin ativa via SparkBot chat por enquanto.
      // Commit 4.1.C trará botões direto no /hub/campaigns/[id].
      status: "paused",
      label: body.label.trim() + (isSequence ? ` (${body.sequence_steps!.length} toques)` : ""),
      total_contacts: 0,
      // Etapa 4.4: flag pro populator do PATCH saber que precisa criar
      // bulk_message_sequence_state rows quando job vira running.
      has_sequence: isSequence,
    })
    .select("id")
    .single();

  if (error) {
    return errorResponse(error.message, 500, "db_error");
  }

  // Etapa 4.4: grava bulk_message_sequences se for multi-toque.
  // Step 1 também entra na tabela (mesmo com delay_days=0) pra runner ter um
  // estado consistente: state.current_step sempre aponta pra row em sequences.
  // Tabela criada na migration 00089.
  if (body.sequence_steps && body.sequence_steps.length > 0) {
    const rows = body.sequence_steps.map((s, idx) => ({
      job_id: job.id,
      step_number: idx + 1,
      template: s.template.trim(),
      delay_days: s.delay_days,
      pause_on_reply: s.pause_on_reply ?? true,
    }));
    const { error: seqErr } = await supabase
      .from("bulk_message_sequences")
      .insert(rows);
    if (seqErr) {
      // Se falhou inserir steps, rollback do job (CASCADE não está ativo pra
      // bulk_message_jobs.delete; melhor remover na mão).
      await supabase.from("bulk_message_jobs").delete().eq("id", job.id);
      return errorResponse("Falha ao salvar passos da sequência: " + seqErr.message, 500, "db_error");
    }
  }

  return NextResponse.json({
    ok: true,
    id: job.id,
    status: "paused",
    sequence_steps: body.sequence_steps?.length ?? 1,
  }, { status: 201 });
}
