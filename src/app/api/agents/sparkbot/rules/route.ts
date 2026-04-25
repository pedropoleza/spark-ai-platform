import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";

/**
 * GET /api/agents/sparkbot/rules
 *
 * Lista todas as regras de proatividade do Sparkbot. Sparkbot é global
 * (único na plataforma) — qualquer admin autenticado vê.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();

  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  if (!hubLocationId) return errorResponse("Hub não configurado", 500, "hub_not_configured");

  const supabase = createAdminClient();

  // Sparkbot agent
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .maybeSingle();
  if (!agent) return NextResponse.json({ rules: [] });

  const { data: rules } = await supabase
    .from("assistant_proactive_rules")
    .select("*")
    .eq("agent_id", agent.id)
    .order("source", { ascending: true })
    .order("rule_type", { ascending: true })
    .order("name", { ascending: true });

  return NextResponse.json({
    rules: rules || [],
    agent_id: agent.id,
  });
}

/**
 * POST /api/agents/sparkbot/rules
 *
 * Cria uma regra customizada (source='custom').
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json();
  const {
    rule_type,
    name,
    description,
    trigger_config,
    prompt_instruction,
    tools_allowed,
    cooldown_minutes,
    ai_model,
  } = body;

  if (!rule_type || !["reactive", "scheduled"].includes(rule_type)) {
    return errorResponse("rule_type inválido (reactive|scheduled)", 400, "invalid_rule_type");
  }
  if (!name || !prompt_instruction || !trigger_config) {
    return errorResponse("name, prompt_instruction e trigger_config obrigatórios", 400, "missing_fields");
  }

  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  if (!hubLocationId) return errorResponse("Hub não configurado", 500, "hub_not_configured");

  const supabase = createAdminClient();
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .maybeSingle();
  if (!agent) return errorResponse("Sparkbot agent não existe", 500, "no_agent");

  const { data: rule, error } = await supabase
    .from("assistant_proactive_rules")
    .insert({
      agent_id: agent.id,
      rule_type,
      name: String(name).slice(0, 100),
      description: description ? String(description).slice(0, 500) : null,
      trigger_config,
      prompt_instruction: String(prompt_instruction).slice(0, 3000),
      tools_allowed: Array.isArray(tools_allowed) ? tools_allowed : null,
      cooldown_minutes: typeof cooldown_minutes === "number" ? cooldown_minutes : 60,
      ai_model: ai_model || "claude-haiku-4-5-20251001",
      source: "custom",
      enabled: true,
    })
    .select()
    .single();

  if (error) return errorResponse(error.message, 500, "db_error");
  return NextResponse.json({ rule }, { status: 201 });
}
