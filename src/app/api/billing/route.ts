import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

// GET /api/billing?period=7d|30d|all
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const period = request.nextUrl.searchParams.get("period") || "30d";
  const supabase = createServerClient();

  let sinceDate: string;
  if (period === "7d") {
    sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (period === "all") {
    sinceDate = "2020-01-01T00:00:00Z";
  } else {
    sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  // Buscar resumo
  const { data: records } = await supabase
    .from("usage_records")
    .select("*")
    .eq("location_id", session.locationId)
    .gte("created_at", sinceDate)
    .order("created_at", { ascending: false });

  const allRecords = records || [];

  // Calcular totais
  const summary = {
    total_interactions: allRecords.length,
    total_tokens: allRecords.reduce((sum, r) => sum + (r.total_tokens || 0), 0),
    total_cost_usd: allRecords.reduce((sum, r) => sum + Number(r.cost_usd || 0), 0),
    total_markup_usd: allRecords.reduce((sum, r) => sum + Number(r.markup_usd || 0), 0),
    total_charged_usd: allRecords.reduce((sum, r) => sum + Number(r.total_charge_usd || 0), 0),
    using_custom_key: allRecords.filter((r) => r.uses_custom_key).length,
    using_platform_key: allRecords.filter((r) => !r.uses_custom_key).length,
    pending_charges: allRecords.filter((r) => !r.charged_to_wallet && !r.uses_custom_key).length,
  };

  // Agrupar por dia para grafico
  const dailyMap = new Map<string, { tokens: number; cost: number; interactions: number }>();
  for (const r of allRecords) {
    const day = r.created_at.split("T")[0];
    const existing = dailyMap.get(day) || { tokens: 0, cost: 0, interactions: 0 };
    existing.tokens += r.total_tokens || 0;
    existing.cost += Number(r.total_charge_usd || 0);
    existing.interactions += 1;
    dailyMap.set(day, existing);
  }

  const daily = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Agrupar por modelo
  const byModel = new Map<string, { tokens: number; cost: number; count: number }>();
  for (const r of allRecords) {
    const model = r.ai_model || "unknown";
    const existing = byModel.get(model) || { tokens: 0, cost: 0, count: 0 };
    existing.tokens += r.total_tokens || 0;
    existing.cost += Number(r.total_charge_usd || 0);
    existing.count += 1;
    byModel.set(model, existing);
  }

  const models = Array.from(byModel.entries())
    .map(([model, data]) => ({ model, ...data }));

  // Ultimos 20 registros detalhados
  const recent = allRecords.slice(0, 20).map((r) => ({
    id: r.id,
    action_type: r.action_type,
    model: r.ai_model,
    tokens: r.total_tokens,
    cost: Number(r.total_charge_usd),
    custom_key: r.uses_custom_key,
    charged: r.charged_to_wallet,
    created_at: r.created_at,
  }));

  return NextResponse.json({ summary, daily, models, recent });
}
