import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { unauthorized } from "@/lib/utils/api";
import { resolvePrimaryHub, getEnvHubLocationId } from "@/lib/account-assistant/hub-resolver";

/**
 * GET /api/agents/sparkbot
 *
 * Retorna o agent account_assistant do Hub ativo. O hub é resolvido via DB
 * (resolvePrimaryHub) com fallback na env ASSISTANT_HUB_LOCATION_ID.
 * Diferente dos outros agents, o Sparkbot é único globalmente — todos os admins
 * enxergam o mesmo. A config é editada via /api/agents/[agentId]/config padrão.
 *
 * Query param ?debug=1 retorna info extra pra troubleshooting.
 *
 * H29 2026-05-20: migrado de env-only pra DB-first (hub-resolver).
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const isDebug = request.nextUrl.searchParams.get("debug") === "1";

  // H29: resolve hub via DB (multi-hub ready) com fallback env
  const hub = await resolvePrimaryHub();
  const hubLocationId = hub?.locationId ?? getEnvHubLocationId();

  const debugInfo: Record<string, unknown> = isDebug
    ? {
        has_hub: !!hubLocationId,
        hub_source: hub ? "db" : (getEnvHubLocationId() ? "env_fallback" : "none"),
        hub_location_preview: hubLocationId ? hubLocationId.substring(0, 8) + "…" : null,
        session_location: session.locationId,
      }
    : {};

  if (!hubLocationId) {
    console.error("[sparkbot endpoint] nenhum hub ativo encontrado (DB + env)");
    return NextResponse.json({ agent: null, ...debugInfo, reason: "no_hub" });
  }

  const supabase = createAdminClient();

  // Se o hub veio do DB com agentId resolvido, podemos usar direto
  if (hub?.agentId) {
    const { data: agent, error } = await supabase
      .from("agents")
      .select("id, type, status, name, location_id, created_at, updated_at")
      .eq("id", hub.agentId)
      .maybeSingle();
    if (error) {
      console.error("[sparkbot endpoint] DB error:", error.message);
      return NextResponse.json({ agent: null, ...debugInfo, reason: "db_error", error: error.message });
    }
    if (!agent) {
      console.warn("[sparkbot endpoint] agent não encontrado pelo id", hub.agentId);
      return NextResponse.json({ agent: null, ...debugInfo, reason: "not_found" });
    }
    return NextResponse.json({ agent, ...debugInfo });
  }

  // Fallback: busca por location_id (env fallback path ou agentId vazio)
  const { data: agent, error } = await supabase
    .from("agents")
    .select("id, type, status, name, location_id, created_at, updated_at")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .maybeSingle();

  if (error) {
    console.error("[sparkbot endpoint] DB error:", error.message);
    return NextResponse.json({ agent: null, ...debugInfo, reason: "db_error", error: error.message });
  }

  if (!agent) {
    console.warn("[sparkbot endpoint] agent não encontrado para location", hubLocationId);
    return NextResponse.json({ agent: null, ...debugInfo, reason: "not_found" });
  }

  return NextResponse.json({ agent, ...debugInfo });
}
