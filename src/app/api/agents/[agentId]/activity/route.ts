import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

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

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const messageTypes = ["send_message", "reaction_send_text", "reaction_send_media"];

  const [lastActivityResult, messagesResult] = await Promise.all([
    supabase
      .from("execution_log")
      .select("created_at")
      .eq("agent_id", agentId)
      .eq("location_id", session.locationId)
      .in("action_type", messageTypes)
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("execution_log")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .eq("location_id", session.locationId)
      .in("action_type", messageTypes)
      .eq("success", true)
      .gte("created_at", twentyFourHoursAgo),
  ]);

  return NextResponse.json({
    last_activity: lastActivityResult.data?.created_at || null,
    messages_24h: messagesResult.count || 0,
  });
}
