import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { updateAgentConfigSchema, validateBody } from "@/lib/utils/validation";

// GET /api/agents/[agentId]/config
export async function GET(
  _request: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Verificar que o agente pertence a location do usuario
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", params.agentId)
    .eq("location_id", session.locationId)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  const { data: config, error } = await supabase
    .from("agent_configs")
    .select("*")
    .eq("agent_id", params.agentId)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ config });
}

// PUT /api/agents/[agentId]/config
export async function PUT(
  request: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const { data: validatedBody, error: validationError } = validateBody(updateAgentConfigSchema, body);

  if (validationError || !validatedBody) {
    return NextResponse.json({ error: validationError || "Dados invalidos" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", params.agentId)
    .eq("location_id", session.locationId)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  // Filtra campos null/undefined para nao enviar ao Supabase
  const updateData: Record<string, unknown> = {
    ...Object.fromEntries(
      Object.entries(validatedBody as Record<string, unknown>).filter(([, v]) => v != null)
    ),
    updated_at: new Date().toISOString(),
  };

  const { data: config, error } = await supabase
    .from("agent_configs")
    .update(updateData)
    .eq("agent_id", params.agentId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ config });
}
