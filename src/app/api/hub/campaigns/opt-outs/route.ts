/**
 * GET/POST/DELETE /api/hub/campaigns/opt-outs (Etapa 4.8 — Pedro 2026-05-28).
 *
 * GET: lista opt-outs ativos da location.
 * POST: opt-in/opt-out manual de 1 contato (admin).
 * DELETE: remove opt-out de 1 contato (= contato volta a receber).
 *
 * Scope-check por location_id pra anti-IDOR.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export const maxDuration = 10;

const PostSchema = z.object({
  contact_id: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
});

const DeleteSchema = z.object({
  contact_id: z.string().min(1).max(200),
});

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("outreach_optouts")
    .select("id, contact_id, source, reason, created_at")
    .eq("location_id", session.locationId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({
    ok: true,
    items: data || [],
  });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const parsed = PostSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse(
      "Dados inválidos: " + parsed.error.issues.map((i) => i.message).join("; "),
      400,
      "invalid_input",
    );
  }
  const { contact_id, reason } = parsed.data;

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("outreach_optouts")
    .insert({
      location_id: session.locationId,
      contact_id,
      source: "manual",
      reason: reason || "added_by_admin",
    });
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, already_opted_out: true });
    }
    return errorResponse(error.message, 500, "db_error");
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const parsed = DeleteSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse("Falta contact_id", 400, "invalid_input");
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("outreach_optouts")
    .delete()
    .eq("location_id", session.locationId)
    .eq("contact_id", parsed.data.contact_id)
    .select("id");
  if (error) return errorResponse(error.message, 500, "db_error");
  if (!data || data.length === 0) {
    return errorResponse("Contato não estava opt-out", 404, "not_found");
  }
  return NextResponse.json({ ok: true });
}
