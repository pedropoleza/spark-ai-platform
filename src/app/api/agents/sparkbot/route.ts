import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";

/**
 * GET /api/agents/sparkbot
 *
 * Retorna o agent account_assistant da Hub location (ASSISTANT_HUB_LOCATION_ID).
 * Diferente dos outros agents, o Sparkbot é único globalmente — todos os admins
 * enxergam o mesmo. A config é editada via /api/agents/[agentId]/config padrão.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();

  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID;
  if (!hubLocationId) {
    return errorResponse("Hub não configurado", 500, "hub_not_configured");
  }

  const supabase = createAdminClient();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, type, status, name, location_id, created_at, updated_at")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .maybeSingle();

  if (!agent) {
    return NextResponse.json({ agent: null });
  }

  return NextResponse.json({ agent });
}
