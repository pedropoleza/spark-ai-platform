/**
 * POST /api/agent-platform/builder/commit — cria um agente de LEAD a partir do
 * spec do wizard. Serve os 3 templates lead-facing: venda, recrutamento e custom.
 *
 * Body: { spec: AgentSpec, template?: "sales"|"recruitment"|"custom" }
 * - template → tipo do agente (sales_agent/recruitment_agent/custom_agent) +
 *   template_key + audience=lead. Default "custom" (retrocompat).
 * - Entitlement (flag-aware): admin libera; lead-facing exige liberação.
 * - Cria agente PAUSADO + agent_configs (specToConfig) + agent_module_instances
 *   (módulos derivados do spec ∪ default_modules do template).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { checkAgentEntitlement } from "@/lib/agent-platform/entitlements";
import { listModules, getTemplate } from "@/lib/repositories/agent-platform.repo";
import { AgentSpecSchema, specToConfig } from "@/lib/agent-platform/builder-spec";
import { DEFAULT_SALES_DATA_FIELDS, DEFAULT_RECRUITMENT_DATA_FIELDS } from "@/types/agent";

export const dynamic = "force-dynamic";

type Template = "sales" | "recruitment" | "custom";
type AgentType = "sales_agent" | "recruitment_agent" | "custom_agent";
const TEMPLATE_TO_TYPE: Record<Template, AgentType> = {
  sales: "sales_agent",
  recruitment: "recruitment_agent",
  custom: "custom_agent",
};
const TYPE_LABEL: Record<AgentType, string> = {
  sales_agent: "venda",
  recruitment_agent: "recrutamento",
  custom_agent: "personalizado",
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const parsed = AgentSpecSchema.safeParse(body.spec);
  if (!parsed.success) {
    return errorResponse("Configuração inválida do agente.", 400, "invalid_spec");
  }
  const spec = parsed.data;
  const template: Template = (["sales", "recruitment", "custom"] as const).includes(body.template)
    ? (body.template as Template)
    : "custom";
  const agentType = TEMPLATE_TO_TYPE[template];

  // Entitlement: lead-facing é pago. Admin libera; flag AGENT_ENTITLEMENTS_ENFORCED
  // controla se bloqueia de fato (default log-first).
  const ent = await checkAgentEntitlement({
    locationId: session.locationId,
    agentType,
    isAdmin: session.isAdmin,
  });
  if (!ent.allowed) {
    return errorResponse(
      `Agente de ${TYPE_LABEL[agentType]} é um módulo pago e ainda não está liberado pra esta conta. Fale com o suporte.`,
      403,
      "entitlement_required",
    );
  }

  const catalog = await listModules();
  const allowed = catalog.map((m) => m.key);
  const { config, moduleKeys, expiresAt } = specToConfig(spec, allowed);

  // Fallback de qualificação: se o wizard não gerou campos, usa os defaults do
  // tipo (venda/recrutamento têm um conjunto padrão útil).
  if (!Array.isArray(config.data_fields) || (config.data_fields as unknown[]).length === 0) {
    config.data_fields =
      agentType === "recruitment_agent" ? DEFAULT_RECRUITMENT_DATA_FIELDS : agentType === "sales_agent" ? DEFAULT_SALES_DATA_FIELDS : [];
  }

  // Módulos = derivados do spec ∪ baseline do template (não perde capacidades
  // padrão do tipo que o wizard não pergunta explicitamente).
  const tpl = await getTemplate(template);
  const baseline = Array.isArray(tpl?.default_modules) ? (tpl!.default_modules as string[]) : [];
  const finalModules = Array.from(new Set([...moduleKeys, ...baseline])).filter((k) => allowed.includes(k));

  const supabase = createAdminClient();

  // Nasce PAUSADO (status inactive) — revisa, testa e ativa.
  const agentRow: Record<string, unknown> = {
    location_id: session.locationId,
    type: agentType,
    status: "inactive",
    name: spec.name,
    audience: "lead",
    template_key: template,
    expires_at: expiresAt,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: agent, error: agentErr } = await supabase.from("agents").insert(agentRow as any).select().single();
  if (agentErr || !agent) {
    // UNIQUE(location_id, type) — venda/recrutamento são 1 por location.
    if (agentErr?.code === "23505") {
      return errorResponse(
        `Já existe um agente de ${TYPE_LABEL[agentType]} nesta conta. Abra ele pra reconfigurar.`,
        409,
        "duplicate_agent",
      );
    }
    return errorResponse(agentErr?.message || "Falha ao criar agente", 500, "db_error");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: cfgErr } = await supabase.from("agent_configs").insert({ agent_id: agent.id, ...config } as any);
  if (cfgErr) console.warn("[builder/commit] config:", cfgErr.message);

  if (finalModules.length > 0) {
    const rows = finalModules.map((module_key, i) => ({
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
