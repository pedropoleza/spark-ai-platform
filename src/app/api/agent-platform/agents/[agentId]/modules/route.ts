/**
 * PATCH /api/agent-platform/agents/[agentId]/modules
 *
 * Liga/desliga um módulo do agente (agent_module_instances.enabled). Ligar um
 * módulo que ainda não existe = "Adicionar módulo" (cria a instance). Desligar
 * mantém a row (enabled=false) pra preservar settings/ordem.
 *
 * Body: { module_key: string, enabled: boolean }
 * Auth SSO + ownership (location). SparkBot (account_assistant) é global p/ admin.
 * Plataforma Modular (Fase 3 / config modular).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { listModules } from "@/lib/repositories/agent-platform.repo";
import { assertLocationInCompany } from "@/lib/agent-platform/entitlement-admin";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const moduleKey = String(body.module_key || "").trim();
  const enabled = body.enabled === true;
  if (!moduleKey) return errorResponse("module_key obrigatório", 400, "missing_module");

  const supabase = createAdminClient();

  // Ownership: SparkBot é global pra admin; outros exigem a location da sessão.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, type, location_id")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return errorResponse("Agente não encontrado", 404, "not_found");
  // SparkBot é global pro admin, mas SÓ dentro da MESMA company (anti cross-tenant;
  // fix ultra-review 2026-05-26). Outros agents: a própria location.
  if (agent.type === "account_assistant") {
    if (!(await assertLocationInCompany(agent.location_id, session.companyId))) {
      return errorResponse("Agente não encontrado", 404, "not_found");
    }
  } else if (agent.location_id !== session.locationId) {
    return errorResponse("Agente não encontrado", 404, "not_found");
  }

  // Whitelist: module_key precisa existir no catálogo ativo.
  const catalog = await listModules();
  if (!catalog.some((m) => m.key === moduleKey)) {
    return errorResponse("Módulo inválido", 400, "invalid_module");
  }

  const { data: existing } = await supabase
    .from("agent_module_instances")
    .select("id")
    .eq("agent_id", agentId)
    .eq("module_key", moduleKey)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("agent_module_instances")
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) return errorResponse(error.message, 500, "db_error");
  } else if (enabled) {
    const { data: maxRow } = await supabase
      .from("agent_module_instances")
      .select("sort_order")
      .eq("agent_id", agentId)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSort = (((maxRow?.sort_order as number) ?? 0) || 0) + 10;
    const { error } = await supabase.from("agent_module_instances").insert({
      agent_id: agentId,
      module_key: moduleKey,
      module_version: 1,
      enabled: true,
      sort_order: nextSort,
    });
    if (error) return errorResponse(error.message, 500, "db_error");
  }
  // (não existe + enabled=false) = no-op.

  return NextResponse.json({ ok: true, module_key: moduleKey, enabled });
}
