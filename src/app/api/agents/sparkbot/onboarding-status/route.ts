import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { normalizePhone, identifyRep } from "@/lib/account-assistant/identity";

/**
 * GET /api/agents/sparkbot/onboarding-status
 *
 * Retorna se o admin logado já tem mensagens registradas como rep do
 * SparkBot. Usado pra mostrar/esconder o Setup Wizard na página
 * `/agents/account-assistant`.
 *
 * Response: { ok, first_time, whatsapp_number, rep_id, has_messages, last_msg_at }
 *
 * - `first_time`: true se rep nunca interagiu (sem msgs em sparkbot_messages)
 * - `whatsapp_number`: número pra mostrar no QR (env SPARKBOT_WHATSAPP_NUMBER
 *   ou default `+18134079657`)
 *
 * Auth: SSO session (createServerClient via getSession). Endpoint é
 * agency-internal (não exposto pro rep). Pedro 2026-05-04: usado pelo
 * Setup Wizard no AI Hub UI.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const whatsappNumber = process.env.SPARKBOT_WHATSAPP_NUMBER?.trim() || "+18134079657";

  // Resolve phone do admin via API GHL (mesmo padrão do test/route.ts).
  // Sem phone, marca first_time=true (sem rep existente, óbvio).
  let phone: string | null = null;
  try {
    const supabase = createAdminClient();
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", session.locationId)
      .maybeSingle();
    if (location) {
      const client = new GHLClient(location.company_id, session.locationId);
      const res = await client.get<{
        user?: { phone?: string; phoneNumber?: string; mobile?: string; phone_number?: string };
      }>(`/users/${session.userId}`);
      const u = res.user || {};
      const rawPhone = u.phone || u.phoneNumber || u.mobile || u.phone_number || null;
      phone = rawPhone ? normalizePhone(rawPhone) : null;
    }
  } catch (err) {
    console.warn(
      "[onboarding-status] failed to fetch phone:",
      err instanceof Error ? err.message : err,
    );
  }

  if (!phone) {
    return NextResponse.json({
      ok: true,
      first_time: true,
      whatsapp_number: whatsappNumber,
      rep_id: null,
      has_messages: false,
      last_msg_at: null,
      reason_no_phone: true,
    });
  }

  // Identifica rep via phone — sem criar (essa rota é só consulta)
  const rep = await identifyRep(phone);
  if (!rep) {
    return NextResponse.json({
      ok: true,
      first_time: true,
      whatsapp_number: whatsappNumber,
      rep_id: null,
      has_messages: false,
      last_msg_at: null,
    });
  }

  // Busca última msg do rep (pra mostrar timestamp no UI)
  const supabase = createAdminClient();
  const { data: lastMsg } = await supabase
    .from("sparkbot_messages")
    .select("id, created_at")
    .eq("rep_id", rep.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    first_time: !lastMsg,
    whatsapp_number: whatsappNumber,
    rep_id: rep.id,
    has_messages: !!lastMsg,
    last_msg_at: lastMsg?.created_at || null,
  });
}
