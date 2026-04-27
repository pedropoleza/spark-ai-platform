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

  // Validação explícita (igual ao POST — sem .slice silencioso que perde
  // conteúdo). Se admin manda algo fora do range, falha rápido com
  // mensagem clara em vez de truncar e fingir que deu certo.
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 100)) {
    return errorResponse("name deve ter entre 1 e 100 caracteres", 400, "name_invalid");
  }
  if (body.prompt_instruction !== undefined && (typeof body.prompt_instruction !== "string" || body.prompt_instruction.length === 0 || body.prompt_instruction.length > 3000)) {
    return errorResponse("prompt_instruction deve ter entre 1 e 3000 caracteres", 400, "prompt_invalid");
  }
  if (body.description !== undefined && body.description !== null && (typeof body.description !== "string" || body.description.length > 500)) {
    return errorResponse("description deve ter no máximo 500 caracteres", 400, "description_too_long");
  }
  if (body.cooldown_minutes !== undefined && (typeof body.cooldown_minutes !== "number" || body.cooldown_minutes < 0 || body.cooldown_minutes > 10080)) {
    return errorResponse("cooldown_minutes deve ser número entre 0 e 10080 (1 semana)", 400, "invalid_cooldown");
  }
  if (body.rule_type !== undefined && !["reactive", "scheduled"].includes(body.rule_type)) {
    return errorResponse("rule_type inválido (reactive|scheduled)", 400, "invalid_rule_type");
  }

  // Campos permitidos (não muda agent_id, source, created_at).
  // last_modified_by_user_id rastreia quem fez a última alteração (audit).
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    last_modified_by_user_id: session.userId,
  };
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (body.name !== undefined) update.name = body.name;
  if (body.description !== undefined) {
    update.description = body.description ? body.description : null;
  }
  if (body.prompt_instruction !== undefined) update.prompt_instruction = body.prompt_instruction;
  if (body.trigger_config) update.trigger_config = body.trigger_config;
  if (body.tools_allowed !== undefined) {
    update.tools_allowed = Array.isArray(body.tools_allowed) ? body.tools_allowed : null;
  }
  if (typeof body.cooldown_minutes === "number") update.cooldown_minutes = body.cooldown_minutes;
  if (body.ai_model) update.ai_model = body.ai_model;
  // rule_type só editável em source='custom'. Mudar tipo de uma system rule
  // quebraria a semântica esperada (e.g., briefing_8am virar reactive não faz sentido).
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
