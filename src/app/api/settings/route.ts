import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

// GET /api/settings
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data: settings } = await supabase
    .from("location_settings")
    .select("*")
    .eq("location_id", session.locationId)
    .single();

  // Mascarar API key
  const masked = settings ? {
    ...settings,
    openai_api_key: settings.openai_api_key
      ? `sk-...${settings.openai_api_key.slice(-4)}`
      : null,
    has_custom_key: !!settings.openai_api_key,
  } : null;

  return NextResponse.json({
    settings: masked,
    webhook_url: `https://spark-ai-platform.vercel.app/api/webhooks/inbound-message`,
    location_id: session.locationId,
  });
}

// PUT /api/settings
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const supabase = createServerClient();

  const allowedFields = [
    "openai_api_key",
    "default_timezone",
    "daily_message_limit",
    "cost_alert_threshold",
  ];

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const field of allowedFields) {
    if (field in body) {
      updateData[field] = body[field];
    }
  }

  const { data, error } = await supabase
    .from("location_settings")
    .upsert(
      { location_id: session.locationId, ...updateData },
      { onConflict: "location_id" }
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ settings: data });
}
