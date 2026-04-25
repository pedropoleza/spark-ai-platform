import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";

/**
 * PUT /api/agents/sparkbot/rules/[ruleId]
 *
 * Atualiza uma regra. Pode mudar enabled, prompt_instruction, trigger_config,
 * tools_allowed, cooldown, ai_model. System rules podem ser editadas mas não
 * podem ter source virado pra custom (conserva o status).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> },
) {
  const session = await getSession();
  if (!session) return unauthorized();

  const { ruleId } = await params;
  const body = await request.json();

  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("assistant_proactive_rules")
    .select("*")
    .eq("id", ruleId)
    .maybeSingle();
  if (!existing) return errorResponse("Regra não encontrada", 404, "not_found");

  // Campos permitidos (não muda agent_id, source, created_at)
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (body.name) update.name = String(body.name).slice(0, 100);
  if (body.description !== undefined) {
    update.description = body.description ? String(body.description).slice(0, 500) : null;
  }
  if (body.prompt_instruction) update.prompt_instruction = String(body.prompt_instruction).slice(0, 3000);
  if (body.trigger_config) update.trigger_config = body.trigger_config;
  if (body.tools_allowed !== undefined) {
    update.tools_allowed = Array.isArray(body.tools_allowed) ? body.tools_allowed : null;
  }
  if (typeof body.cooldown_minutes === "number") update.cooldown_minutes = body.cooldown_minutes;
  if (body.ai_model) update.ai_model = body.ai_model;
  // rule_type só editável em system source NULL ou se não tiver disparado nada
  if (body.rule_type && existing.source === "custom") {
    update.rule_type = body.rule_type;
  }

  const { data: updated, error } = await supabase
    .from("assistant_proactive_rules")
    .update(update)
    .eq("id", ruleId)
    .select()
    .single();

  if (error) return errorResponse(error.message, 500, "db_error");
  return NextResponse.json({ rule: updated });
}

/**
 * DELETE /api/agents/sparkbot/rules/[ruleId]
 *
 * Apaga uma regra. System rules NÃO podem ser deletadas (apenas desabilitadas).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> },
) {
  const session = await getSession();
  if (!session) return unauthorized();

  const { ruleId } = await params;
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("assistant_proactive_rules")
    .select("source")
    .eq("id", ruleId)
    .maybeSingle();
  if (!existing) return errorResponse("Regra não encontrada", 404, "not_found");
  if (existing.source === "system") {
    return errorResponse(
      "Regras pré-configuradas não podem ser apagadas. Desabilite via toggle ou edite o conteúdo.",
      400, "cannot_delete_system",
    );
  }

  const { error } = await supabase.from("assistant_proactive_rules").delete().eq("id", ruleId);
  if (error) return errorResponse(error.message, 500, "db_error");
  return NextResponse.json({ deleted: ruleId });
}
