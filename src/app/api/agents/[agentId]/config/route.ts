import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { updateAgentConfigSchema, validateBody } from "@/lib/utils/validation";
import { assertLocationInCompany } from "@/lib/agent-platform/entitlement-admin";

// GET /api/agents/[agentId]/config
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Sparkbot (account_assistant) é global — qualquer admin autenticado pode
  // ler/editar. Outros agents continuam limitados à location do admin.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, type, location_id")
    .eq("id", agentId)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }
  // SparkBot (account_assistant) é "global" pro admin — mas SÓ dentro da MESMA
  // company (fix P0 ultra-review 2026-05-26: antes pulava QUALQUER checagem pra
  // account_assistant → qualquer sessão de qualquer conta editava o prompt do bot
  // de outra company). Espelha o hardening que a KB já tem (resolveKbLocation).
  if (agent.type === "account_assistant") {
    if (!agent.location_id || !(await assertLocationInCompany(agent.location_id, session.companyId))) {
      return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
    }
    // E admin-only (fix P0 ultra-review 2026-05-26): a config global do SparkBot
    // (system_prompt_override/custom_instructions/disabled_tools/confirmation_mode)
    // não pode ser lida nem editada por não-admin. Casa com o hardening do
    // isUserAdmin (sso.ts, mesma review) que tirou o "todo usuário logado é admin".
    if (!session.isAdmin) {
      return NextResponse.json({ error: "Apenas admin pode acessar a config do SparkBot" }, { status: 403 });
    }
  } else if (agent.location_id !== session.locationId) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  const { data: config, error } = await supabase
    .from("agent_configs")
    .select("*")
    .eq("agent_id", agentId)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ config });
}

// PUT /api/agents/[agentId]/config
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
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
    .select("id, type, location_id")
    .eq("id", agentId)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }
  // SparkBot (account_assistant) é "global" pro admin — mas SÓ dentro da MESMA
  // company (fix P0 ultra-review 2026-05-26: antes pulava QUALQUER checagem pra
  // account_assistant → qualquer sessão de qualquer conta editava o prompt do bot
  // de outra company). Espelha o hardening que a KB já tem (resolveKbLocation).
  if (agent.type === "account_assistant") {
    if (!agent.location_id || !(await assertLocationInCompany(agent.location_id, session.companyId))) {
      return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
    }
    // E admin-only (fix P0 ultra-review 2026-05-26): a config global do SparkBot
    // (system_prompt_override/custom_instructions/disabled_tools/confirmation_mode)
    // não pode ser lida nem editada por não-admin. Casa com o hardening do
    // isUserAdmin (sso.ts, mesma review) que tirou o "todo usuário logado é admin".
    if (!session.isAdmin) {
      return NextResponse.json({ error: "Apenas admin pode acessar a config do SparkBot" }, { status: 403 });
    }
  } else if (agent.location_id !== session.locationId) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  // Filtra campos null/undefined para nao enviar ao Supabase
  const updateData: Record<string, unknown> = {
    ...Object.fromEntries(
      Object.entries(validatedBody as Record<string, unknown>).filter(([, v]) => v != null)
    ),
    updated_at: new Date().toISOString(),
  };

  // F39 (Pedro 2026-06-01): retry tolerante a schema cache stale (PGRST204).
  // Migration que adiciona colunas novas pode demorar pra refletir no cache do
  // PostgREST, ou ainda não ter rodado em prod. Em vez de devolver 500 e
  // bloquear o save, retira o campo problemático e tenta de novo.
  // Loga warning pra rastrear coluna pendente sem quebrar UX.
  const droppedColumns: string[] = [];
  let attempt = 0;
  const MAX_ATTEMPTS = 8;
  while (attempt < MAX_ATTEMPTS) {
    const { data: config, error } = await supabase
      .from("agent_configs")
      .update(updateData)
      .eq("agent_id", agentId)
      .select()
      .single();

    if (!error) {
      if (droppedColumns.length > 0) {
        console.warn(
          `[agent-configs PUT] schema cache stale — colunas removidas do update: ${droppedColumns.join(", ")}. ` +
            `Migration provavelmente não rodou em prod. Save aplicado com restante; verifica migration.`,
        );
      }
      return NextResponse.json({
        config,
        ...(droppedColumns.length > 0 ? { warnings: { missing_columns: droppedColumns } } : {}),
      });
    }

    // PGRST204 = "Could not find the X column of Y in the schema cache"
    const match = /Could not find the '([^']+)' column/.exec(error.message);
    if (error.code === "PGRST204" && match && updateData[match[1]] !== undefined) {
      droppedColumns.push(match[1]);
      delete updateData[match[1]];
      attempt++;
      continue;
    }

    // Outro tipo de erro — devolve
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { error: `Schema cache stale — muitas colunas faltando (${droppedColumns.join(", ")}). Rodar migration pendente.` },
    { status: 500 },
  );
}
