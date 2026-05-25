/**
 * POST /api/agent-platform/builder/commit — cria o agente custom a partir do spec.
 *
 * Body: { spec: AgentSpec }. Valida (zod), checa entitlement (custom_agent —
 * admin bypass, flag-aware), cria o agente PAUSADO + agent_configs (mapeado do
 * spec) + agent_module_instances. Retorna { agent }. Plataforma Modular — Fase F.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { checkAgentEntitlement } from "@/lib/agent-platform/entitlements";
import { listModules } from "@/lib/repositories/agent-platform.repo";
import { AgentSpecSchema, specToConfig } from "@/lib/agent-platform/builder-spec";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const parsed = AgentSpecSchema.safeParse(body.spec);
  if (!parsed.success) {
    return errorResponse("Configuração inválida do agente.", 400, "invalid_spec");
  }
  const spec = parsed.data;

  // Entitlement: custom_agent é pago. Admin libera; flag AGENT_ENTITLEMENTS_ENFORCED
  // controla se bloqueia de fato (default log-first).
  const ent = await checkAgentEntitlement({
    locationId: session.locationId,
    agentType: "custom_agent",
    isAdmin: session.isAdmin,
  });
  if (!ent.allowed) {
    return errorResponse(
      "Agente personalizado é um módulo pago e ainda não está liberado pra esta conta. Fale com o suporte.",
      403,
      "entitlement_required",
    );
  }

  const catalog = await listModules();
  const allowed = catalog.map((m) => m.key);
  const { config, moduleKeys, expiresAt } = specToConfig(spec, allowed);

  const supabase = createAdminClient();

  // Nasce PAUSADO (status inactive) — rep revisa, testa e ativa.
  const agentRow: Record<string, unknown> = {
    location_id: session.locationId,
    type: "custom_agent",
    status: "inactive",
    name: spec.name,
    audience: "lead",
    template_key: "custom",
    expires_at: expiresAt,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: agent, error: agentErr } = await supabase.from("agents").insert(agentRow as any).select().single();
  if (agentErr || !agent) {
    return errorResponse(agentErr?.message || "Falha ao criar agente", 500, "db_error");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: cfgErr } = await supabase.from("agent_configs").insert({ agent_id: agent.id, ...config } as any);
  if (cfgErr) console.warn("[builder/commit] config:", cfgErr.message);

  if (moduleKeys.length > 0) {
    const rows = moduleKeys.map((module_key, i) => ({
      agent_id: agent.id,
      module_key,
      module_version: 1,
      enabled: true,
      sort_order: (i + 1) * 10,
    }));
    const { error: modErr } = await supabase.from("agent_module_instances").insert(rows);
    if (modErr) console.warn("[builder/commit] módulos:", modErr.message);
  }

  return NextResponse.json({ agent }, { status: 201 });
}
