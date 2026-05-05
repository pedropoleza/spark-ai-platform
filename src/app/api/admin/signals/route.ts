import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSignal } from "@/lib/admin-signals/recorder";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/signals
 *
 * Lista signals pro painel admin. Auth via middleware (Basic Auth).
 *
 * Query params:
 *   - status: open|triaged|in_progress|done|wontfix|all (default 'open')
 *   - type: failure|missed_capability|error|idea|all (default 'all')
 *   - period: 7d|30d|all (default 'all')
 *   - limit: number (default 100, max 500)
 */
export async function GET(request: NextRequest) {
  const supabase = createAdminClient();
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "open";
  const type = url.searchParams.get("type") || "all";
  const period = url.searchParams.get("period") || "all";
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100")));

  let query = supabase
    .from("admin_signals")
    .select("*")
    .order("occurrence_count", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (status !== "all") query = query.eq("status", status);
  if (type !== "all") query = query.eq("type", type);
  if (period !== "all") {
    const days = period === "7d" ? 7 : period === "30d" ? 30 : 0;
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("last_seen_at", cutoff);
    }
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Counts por status pro header
  const { data: countsRaw } = await supabase
    .from("admin_signals")
    .select("status, type, occurrence_count");
  type CountsRow = { status: string; type: string; occurrence_count: number };
  const counts: { byStatus: Record<string, number>; byType: Record<string, number> } = {
    byStatus: {},
    byType: {},
  };
  for (const row of (countsRaw || []) as CountsRow[]) {
    counts.byStatus[row.status] = (counts.byStatus[row.status] || 0) + 1;
    counts.byType[row.type] = (counts.byType[row.type] || 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    signals: data || [],
    counts,
    filters: { status, type, period, limit },
  });
}

/**
 * POST /api/admin/signals
 *
 * Cria signal manualmente (Pedro adicionando ideia/falha do painel).
 * Body: { type, title, description?, severity?, metadata? }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const type = String(body.type || "");
  const title = String(body.title || "");
  if (!["failure", "missed_capability", "error", "idea"].includes(type)) {
    return NextResponse.json({ ok: false, error: "type inválido" }, { status: 400 });
  }
  if (!title.trim()) {
    return NextResponse.json({ ok: false, error: "title obrigatório" }, { status: 400 });
  }
  const result = await recordSignal({
    type: type as "failure" | "missed_capability" | "error" | "idea",
    title,
    description: body.description ? String(body.description) : undefined,
    severity: body.severity
      ? (String(body.severity) as "low" | "medium" | "high" | "critical")
      : "medium",
    source: "manual",
    metadata: (body.metadata as Record<string, unknown>) || {},
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    signal_id: result.signal_id,
    was_new: result.was_new,
    occurrence_count: result.occurrence_count,
  });
}
