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

  // C3-6 (ultra-review 2026-05-26): valida cada campo antes de gravar (antes
  // aceitava qualquer valor cru — key malformada, tz inválida, número negativo).
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("openai_api_key" in body) {
    const k = body.openai_api_key;
    if (k === null || k === "") {
      updateData.openai_api_key = null; // limpar BYO key
    } else if (typeof k === "string" && /^sk-/.test(k.trim()) && k.trim().length >= 20) {
      updateData.openai_api_key = k.trim();
    } else {
      return NextResponse.json({ error: "Chave de API inválida (deve começar com sk-)" }, { status: 400 });
    }
  }

  if ("default_timezone" in body) {
    const tz = body.default_timezone;
    if (typeof tz !== "string" || !tz.trim()) {
      return NextResponse.json({ error: "Fuso horário inválido" }, { status: 400 });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }); // lança se tz inválida
      updateData.default_timezone = tz;
    } catch {
      return NextResponse.json({ error: `Fuso horário inválido: ${tz}` }, { status: 400 });
    }
  }

  if ("daily_message_limit" in body) {
    const v = body.daily_message_limit;
    if (v === null) {
      updateData.daily_message_limit = null;
    } else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return NextResponse.json({ error: "Limite diário deve ser inteiro >= 0" }, { status: 400 });
      }
      updateData.daily_message_limit = n;
    }
  }

  if ("cost_alert_threshold" in body) {
    const v = body.cost_alert_threshold;
    if (v === null) {
      updateData.cost_alert_threshold = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: "Limite de alerta de custo deve ser número >= 0" }, { status: 400 });
      }
      updateData.cost_alert_threshold = n;
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
