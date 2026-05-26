/**
 * POST /api/agent-platform/agents — cria um agente a partir do wizard modular.
 *
 * Body: { template_key, name?, module_keys[] }
 * - template_key → tipo + audiência (sparkbot=rep/account_assistant; sales/
 *   recruitment/custom = lead).
 * - Gate de entitlement (SparkBot incluso; lead-facing exige liberação ou admin).
 * - Cria agents (com audience + template_key) + agent_configs default + as
 *   agent_module_instances (composição na ordem dada).
 *
 * Plataforma Modular (Fase 3). Auth SSO.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { checkAgentEntitlement } from "@/lib/agent-platform/entitlements";
import { getTemplate } from "@/lib/repositories/agent-platform.repo";
import { DEFAULT_SALES_DATA_FIELDS, DEFAULT_RECRUITMENT_DATA_FIELDS } from "@/types/agent";

type AgentType = "account_assistant" | "sales_agent" | "recruitment_agent" | "custom_agent";

function templateToType(key: string): { type: AgentType; audience: "rep" | "lead" } {
  switch (key) {
    case "sparkbot":
      return { type: "account_assistant", audience: "rep" };
    case "sales":
      return { type: "sales_agent", audience: "lead" };
    case "recruitment":
      return { type: "recruitment_agent", audience: "lead" };
    default:
      return { type: "custom_agent", audience: "lead" };
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const templateKey = String(body.template_key || "").trim();
  const moduleKeys: string[] = Array.isArray(body.module_keys)
    ? body.module_keys.filter((m: unknown): m is string => typeof m === "string")
    : [];
  // Criação manual nasce PAUSADA (rep revisa + testa + ativa). start_paused=false força ativo.
  const startPaused = body.start_paused !== false;
  if (!templateKey) return errorResponse("template_key obrigatório", 400, "missing_template");

  const template = await getTemplate(templateKey);
  if (!template) return errorResponse("Template não encontrado", 404, "template_not_found");

  const { type, audience } = templateToType(templateKey);

  // Gate de entitlement (flag-aware). SparkBot incluso; lead-facing exige.
  const ent = await checkAgentEntitlement({ locationId: session.locationId, agentType: type, isAdmin: session.isAdmin });
  if (!ent.allowed) {
    return errorResponse(
      "Esse tipo de agente é um módulo pago e ainda não está liberado pra esta conta. Fale com o suporte pra ativar.",
      403,
      "entitlement_required",
    );
  }

  const supabase = createAdminClient();
  const name =
    (typeof body.name === "string" && body.name.trim()) ||
    template.name ||
    "Novo Agente";

  // Cria o agente. UNIQUE(location_id, type) — 1 por tipo/location (custom idem
  // por ora; multi-custom = relaxar o constraint depois).
  const { data: agent, error: agentErr } = await supabase
    .from("agents")
    .insert({
      location_id: session.locationId,
      type,
      status: startPaused ? "inactive" : "active",
      name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audience: audience as any,
      template_key: templateKey,
    })
    .select()
    .single();

  if (agentErr) {
    if (agentErr.code === "23505") {
      return errorResponse("Já existe um agente desse tipo nesta conta.", 409, "duplicate_agent");
    }
    return errorResponse(agentErr.message, 500, "db_error");
  }

  // Config default. Pra agentes de lead, nasce JÁ funcional: canal live
  // (SMS = WhatsApp Web via Stevo), objetivo sensato e os data_fields do tipo.
  // Sem o canal, o agente nascia sem por onde responder (review 2026-05-26).
  const isLead = audience === "lead";
  const defaultDataFields =
    type === "recruitment_agent" ? DEFAULT_RECRUITMENT_DATA_FIELDS : DEFAULT_SALES_DATA_FIELDS;
  await supabase.from("agent_configs").insert({
    agent_id: agent.id,
    data_fields: isLead ? defaultDataFields : [],
    ...(isLead
      ? { enabled_channels: ["SMS"], objective: "qualification_and_booking" }
      : {}),
  });

  // Composição: módulos ligados (na ordem do wizard). Fallback: default_modules
  // do template se o wizard não mandou nada.
  const keys = moduleKeys.length > 0 ? moduleKeys : template.default_modules || [];
  if (keys.length > 0) {
    const rows = keys.map((module_key, i) => ({
      agent_id: agent.id,
      module_key,
      module_version: 1,
      enabled: true,
      sort_order: (i + 1) * 10,
    }));
    const { error: modErr } = await supabase.from("agent_module_instances").insert(rows);
    if (modErr) {
      // Não-fatal: o agente foi criado; só loga a falha de composição.
      console.warn("[agent-platform/agents] falha ao gravar módulos:", modErr.message);
    }
  }

  return NextResponse.json({ agent, modules: keys, audience }, { status: 201 });
}
