import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const supabase = createServerClient();

  const [
    { data: agents },
    { data: pendingMessages },
    { data: recentCompleted },
    { data: recentFailed },
    { data: recentLogs },
    { data: pausedConversations },
  ] = await Promise.all([
    supabase
      .from("agents")
      .select("id, type, status, name")
      .eq("location_id", session.locationId),
    supabase
      .from("message_queue")
      .select("id, agent_id, contact_id, status, message_body, process_after, created_at")
      .eq("location_id", session.locationId)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("message_queue")
      .select("id, agent_id, contact_id, status, created_at")
      .eq("location_id", session.locationId)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("message_queue")
      .select("id, agent_id, contact_id, status, created_at")
      .eq("location_id", session.locationId)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("execution_log")
      .select("action_type, success, error_message, created_at")
      .eq("location_id", session.locationId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("conversation_state")
      .select("agent_id, contact_id, status, ai_paused_at, ai_paused_reason")
      .eq("location_id", session.locationId)
      .not("ai_paused_at", "is", null)
      .limit(10),
  ]);

  return NextResponse.json({
    location_id: session.locationId,
    agents: agents || [],
    queue: {
      pending: pendingMessages || [],
      recent_completed: recentCompleted || [],
      recent_failed: recentFailed || [],
    },
    recent_execution_logs: recentLogs || [],
    paused_conversations: pausedConversations || [],
    env_check: {
      has_openai_key: !!process.env.OPENAI_API_KEY,
      has_cron_secret: !!process.env.CRON_SECRET,
      has_app_url: !!(process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL),
      vercel_url: process.env.VERCEL_URL || "(not set)",
    },
    timestamp: new Date().toISOString(),
  });
}
