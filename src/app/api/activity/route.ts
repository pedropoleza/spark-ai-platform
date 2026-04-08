import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

// GET /api/activity?tab=conversations|logs|metrics|followups
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const tab = request.nextUrl.searchParams.get("tab") || "conversations";
  const supabase = createServerClient();

  switch (tab) {
    case "conversations": {
      const { data } = await supabase
        .from("conversation_state")
        .select("*")
        .eq("location_id", session.locationId)
        .order("updated_at", { ascending: false })
        .limit(50);

      return NextResponse.json({ conversations: data || [] });
    }

    case "logs": {
      const { data } = await supabase
        .from("execution_log")
        .select("*")
        .eq("location_id", session.locationId)
        .order("created_at", { ascending: false })
        .limit(100);

      return NextResponse.json({ logs: data || [] });
    }

    case "metrics": {
      // Mensagens enviadas (ultimos 30 dias)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [messagesRes, qualifiedRes, bookedRes, tokensRes] = await Promise.all([
        supabase
          .from("execution_log")
          .select("id", { count: "exact", head: true })
          .eq("location_id", session.locationId)
          .eq("action_type", "send_message")
          .eq("success", true)
          .gte("created_at", thirtyDaysAgo),

        supabase
          .from("conversation_state")
          .select("id", { count: "exact", head: true })
          .eq("location_id", session.locationId)
          .eq("status", "qualified"),

        supabase
          .from("conversation_state")
          .select("id", { count: "exact", head: true })
          .eq("location_id", session.locationId)
          .eq("status", "booked"),

        supabase
          .from("execution_log")
          .select("prompt_tokens, completion_tokens")
          .eq("location_id", session.locationId)
          .eq("action_type", "ai_processing")
          .gte("created_at", thirtyDaysAgo),
      ]);

      const totalTokens = (tokensRes.data || []).reduce(
        (acc, row) => acc + (row.prompt_tokens || 0) + (row.completion_tokens || 0),
        0
      );

      // Conversas ativas
      const { count: activeConversations } = await supabase
        .from("conversation_state")
        .select("id", { count: "exact", head: true })
        .eq("location_id", session.locationId)
        .eq("status", "active");

      return NextResponse.json({
        metrics: {
          messages_sent: messagesRes.count || 0,
          leads_qualified: qualifiedRes.count || 0,
          appointments_booked: bookedRes.count || 0,
          total_tokens: totalTokens,
          active_conversations: activeConversations || 0,
        },
      });
    }

    case "followups": {
      const { data } = await supabase
        .from("scheduled_followups")
        .select("*")
        .eq("location_id", session.locationId)
        .order("scheduled_at", { ascending: false })
        .limit(50);

      return NextResponse.json({ followups: data || [] });
    }

    default:
      return NextResponse.json({ error: "Tab invalida" }, { status: 400 });
  }
}
