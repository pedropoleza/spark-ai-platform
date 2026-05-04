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

  // Resolve phone do admin via API. Tenta 2 endpoints (single user vs lista
  // por location) — diferentes versões/permissões da API podem responder
  // shapes diferentes. Sem phone, marca first_time=true.
  //
  // Pedro 2026-05-04: bug observado — `/users/{id}` não retornava phone do
  // Manuela mesmo phone cadastrado no profile dela. Fallback pra
  // `/users/?locationId=X` resolve.
  let phone: string | null = null;
  type GhlUser = {
    id?: string;
    phone?: string;
    phoneNumber?: string;
    mobile?: string;
    phone_number?: string;
  };
  const extractPhone = (u: GhlUser | undefined | null): string | null => {
    if (!u) return null;
    const raw = u.phone || u.phoneNumber || u.mobile || u.phone_number || null;
    return raw ? normalizePhone(raw) : null;
  };
  try {
    const supabase = createAdminClient();
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", session.locationId)
      .maybeSingle();
    if (location) {
      const client = new GHLClient(location.company_id, session.locationId);

      // Tentativa 1: /users/{id}
      try {
        const res = await client.get<{ user?: GhlUser }>(`/users/${session.userId}`);
        phone = extractPhone(res.user);
      } catch (e1) {
        console.warn(
          "[onboarding-status] /users/{id} falhou:",
          e1 instanceof Error ? e1.message : e1,
        );
      }

      // Tentativa 2: /users/?locationId=X (se primeira não achou)
      if (!phone) {
        try {
          const res2 = await client.get<{ users?: GhlUser[] }>(
            "/users/",
            { locationId: session.locationId },
          );
          const u = (res2.users || []).find((x) => x.id === session.userId);
          phone = extractPhone(u);
        } catch (e2) {
          console.warn(
            "[onboarding-status] /users/?locationId falhou:",
            e2 instanceof Error ? e2.message : e2,
          );
        }
      }
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

  // Busca última msg DO REP (role='user'). Pedro 2026-05-04: precisa ser
  // role='user' explicitamente — msgs `role='agent'` incluem onboarding
  // seed automático (quando admin abre painel pela primeira vez), e isso
  // NÃO conta como "rep interagiu". Wizard só some quando rep manda msg
  // de verdade (WhatsApp ou Web UI compose).
  const supabase = createAdminClient();
  const { data: lastUserMsg } = await supabase
    .from("sparkbot_messages")
    .select("id, created_at")
    .eq("rep_id", rep.id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    first_time: !lastUserMsg,
    whatsapp_number: whatsappNumber,
    rep_id: rep.id,
    has_messages: !!lastUserMsg,
    last_msg_at: lastUserMsg?.created_at || null,
  });
}
