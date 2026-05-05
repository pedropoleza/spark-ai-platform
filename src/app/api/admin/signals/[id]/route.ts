import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/signals/[id]
 *
 * Atualiza status / severity / admin_notes de um signal.
 * Body: { status?, severity?, admin_notes? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) {
    if (!["open", "triaged", "in_progress", "done", "wontfix"].includes(String(body.status))) {
      return NextResponse.json({ ok: false, error: "status inválido" }, { status: 400 });
    }
    update.status = body.status;
  }
  if (body.severity) {
    if (!["low", "medium", "high", "critical"].includes(String(body.severity))) {
      return NextResponse.json({ ok: false, error: "severity inválido" }, { status: 400 });
    }
    update.severity = body.severity;
  }
  if (body.admin_notes !== undefined) {
    update.admin_notes = body.admin_notes ? String(body.admin_notes).slice(0, 5000) : null;
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("admin_signals")
    .update(update)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "signal não encontrado" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, signal: data });
}

/**
 * DELETE /api/admin/signals/[id]
 *
 * Remove signal (Pedro decide arquivar definitivo). Default é wontfix
 * que mantém histórico — usar DELETE só em spam/duplicado bug.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = createAdminClient();
  const { error } = await supabase.from("admin_signals").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
