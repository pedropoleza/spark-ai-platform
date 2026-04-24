import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { unauthorized } from "@/lib/utils/api";

/**
 * GET /api/agents/sparkbot
 *
 * Retorna o agent account_assistant da Hub location (ASSISTANT_HUB_LOCATION_ID).
 * Diferente dos outros agents, o Sparkbot é único globalmente — todos os admins
 * enxergam o mesmo. A config é editada via /api/agents/[agentId]/config padrão.
 *
 * Query param ?debug=1 retorna info extra pra troubleshooting.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const isDebug = request.nextUrl.searchParams.get("debug") === "1";
  // .trim() defensivo: vercel env add via echo pode preservar \n no final
  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();

  const debugInfo: Record<string, unknown> = isDebug
    ? {
        has_env: !!hubLocationId,
        env_value_preview: hubLocationId ? hubLocationId.substring(0, 8) + "…" : null,
        session_location: session.locationId,
      }
    : {};

  if (!hubLocationId) {
    console.error("[sparkbot endpoint] ASSISTANT_HUB_LOCATION_ID not set");
    return NextResponse.json({ agent: null, ...debugInfo, reason: "no_env" });
  }

  const supabase = createAdminClient();
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
    console.warn("[sparkbot endpoint] no agent found for location", hubLocationId);
    return NextResponse.json({ agent: null, ...debugInfo, reason: "not_found" });
  }

  return NextResponse.json({ agent, ...debugInfo });
}
