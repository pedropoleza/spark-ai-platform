import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { DEFAULT_SALES_DATA_FIELDS, DEFAULT_POST_SALES_DATA_FIELDS } from "@/types/agent";

// GET /api/agents - Listar agentes da location
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: agents, error } = await supabase
    .from("agents")
    .select("*")
    .eq("location_id", session.locationId)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ agents });
}

// POST /api/agents - Criar agente
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const { type } = body;

  if (!type) {
    return NextResponse.json({ error: "Tipo de agente obrigatorio" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Criar agente
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .insert({
      location_id: session.locationId,
      type,
      status: "active",
      name: type === "sales_agent" ? "Agente de Vendas" : type === "post_sales_agent" ? "Agente de Pós-Vendas" : "Assistente de Conta",
    })
    .select()
    .single();

  if (agentError) {
    if (agentError.code === "23505") {
      return NextResponse.json(
        { error: "Ja existe um agente deste tipo para esta location" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: agentError.message }, { status: 500 });
  }

  // Criar config padrao — data_fields ESPECÍFICOS do tipo.
  const defaultDataFields = type === "post_sales_agent"
    ? DEFAULT_POST_SALES_DATA_FIELDS
    : DEFAULT_SALES_DATA_FIELDS;

  const defaultConfigPayload: Record<string, unknown> = {
    agent_id: agent.id,
    data_fields: defaultDataFields,
  };

  // Pós-Vendas: papel default do responsável de atendimento
  if (type === "post_sales_agent") {
    defaultConfigPayload.specialist_role = "responsável de atendimento";
  }

  const { error: configError } = await supabase
    .from("agent_configs")
    .insert(defaultConfigPayload);

  if (configError) {
    console.error("Erro ao criar config padrao:", configError);
  }

  return NextResponse.json({ agent }, { status: 201 });
}
