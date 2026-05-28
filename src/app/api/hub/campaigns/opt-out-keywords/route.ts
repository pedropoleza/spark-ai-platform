/**
 * GET/PUT /api/hub/campaigns/opt-out-keywords (Etapa 4.8).
 *
 * GET: retorna { default: [], custom: [] } pra UI mostrar.
 * PUT: substitui custom keywords da location (admin only — verificação no client).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { listActiveKeywords } from "@/lib/account-assistant/proactive/optout-detector";

export const maxDuration = 10;

const PutSchema = z.object({
  custom_keywords: z.array(z.string().min(1).max(60)).max(50),
});

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();

  const result = await listActiveKeywords(session.locationId);
  return NextResponse.json({ ok: true, ...result });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const parsed = PutSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse(
      "Dados inválidos: " + parsed.error.issues.map((i) => i.message).join("; "),
      400,
      "invalid_input",
    );
  }
  // Normaliza: lowercase, trim, sem duplicatas, sem strings vazias.
  const cleaned = Array.from(
    new Set(
      parsed.data.custom_keywords
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0 && k.length < 60),
    ),
  );

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("location_outreach_settings")
    .upsert(
      {
        location_id: session.locationId,
        custom_optout_keywords: cleaned,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_id" },
    );
  if (error) return errorResponse(error.message, 500, "db_error");

  return NextResponse.json({ ok: true, custom: cleaned });
}
