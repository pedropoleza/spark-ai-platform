import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { DEFAULT_SALES_DATA_FIELDS, DEFAULT_RECRUITMENT_DATA_FIELDS } from "@/types/agent";
import { createAgentSchema, validateBody } from "@/lib/utils/validation";
import { errorResponse, unauthorized } from "@/lib/utils/api";

// GET /api/agents - Listar agentes da location
export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();

  const supabase = createServerClient();
  const { data: agents, error } = await supabase
    .from("agents")
    .select("*")
    .eq("location_id", session.locationId)
    .order("created_at");

  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({ agents });
}

// POST /api/agents - Criar agente
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json();
  const { data: validated, error: validationError } = validateBody(createAgentSchema, body);
  if (validationError || !validated) {
    return errorResponse(validationError || "Dados inválidos", 400, "invalid_body");
  }
  const { type } = validated;

  const supabase = createServerClient();

  // Criar agente
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .insert({
      location_id: session.locationId,
      type,
      status: "active",
      name: type === "sales_agent" ? "Agente de Vendas" : type === "recruitment_agent" ? "Agente de Recrutamento" : "Assistente de Conta",
    })
    .select()
    .single();

  if (agentError) {
    if (agentError.code === "23505") {
      return errorResponse("Já existe um agente deste tipo para esta location", 409, "duplicate_agent");
    }
    return errorResponse(agentError.message, 500, "db_error");
  }

  // Criar config padrao — data_fields ESPECÍFICOS do tipo.
  const defaultDataFields = type === "recruitment_agent"
    ? DEFAULT_RECRUITMENT_DATA_FIELDS
    : DEFAULT_SALES_DATA_FIELDS;

  const defaultConfigPayload: Record<string, unknown> = {
    agent_id: agent.id,
    data_fields: defaultDataFields,
  };

  // Recrutamento: preferência de horário tarde/noite + papel default
  if (type === "recruitment_agent") {
    defaultConfigPayload.preferred_time_slot = "afternoon_evening";
    defaultConfigPayload.specialist_role = "especialista";
  }

  const { error: configError } = await supabase
    .from("agent_configs")
    .insert(defaultConfigPayload);

  if (configError) {
    console.error("Erro ao criar config padrao:", configError);
  }

  return NextResponse.json({ agent }, { status: 201 });
}
