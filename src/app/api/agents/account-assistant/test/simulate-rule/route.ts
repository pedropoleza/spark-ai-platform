import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { identifyRep, normalizePhone, acceptTerms } from "@/lib/account-assistant/identity";
import { dispatchRule } from "@/lib/account-assistant/proactive/dispatcher";
import { errorResponse, unauthorized } from "@/lib/utils/api";

/**
 * POST /api/agents/account-assistant/test/simulate-rule
 *
 * Dispara uma regra de proatividade na sessão de teste do admin logado.
 * Usado pelo botão "Simular agora" do UI. Bypass cooldown e quiet_hours.
 *
 * Body:
 *   { session_id, rule_id, mock_context?, rep_phone? }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json();
  const sessionId: string | undefined = body.session_id;
  const ruleId: string | undefined = body.rule_id;
  const mockContext: Record<string, unknown> = body.mock_context || {};
  const repPhoneOverride: string | undefined = body.rep_phone;

  if (!sessionId || !ruleId) {
    return errorResponse("session_id e rule_id obrigatórios", 400, "missing_params");
  }

  const supabase = createAdminClient();

  // Resolve rule
  const { data: rule } = await supabase
    .from("assistant_proactive_rules")
    .select("*")
    .eq("id", ruleId)
    .maybeSingle();
  if (!rule) return errorResponse("Regra não encontrada", 404, "rule_not_found");

  // Resolve session (validate ownership)
  const { data: testSession } = await supabase
    .from("agent_test_sessions")
    .select("id, agent_id")
    .eq("id", sessionId)
    .eq("location_id", session.locationId)
    .maybeSingle();
  if (!testSession) return errorResponse("Sessão não encontrada", 404, "session_not_found");
  if (testSession.agent_id !== rule.agent_id) {
    return errorResponse("Sessão não bate com agent da regra", 400, "session_agent_mismatch");
  }

  // Resolve rep — mesmo fluxo do test endpoint normal
  let phone: string | null = repPhoneOverride || null;
  if (!phone) {
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", session.locationId)
      .maybeSingle();
    if (!location) return errorResponse("Location não encontrada", 404, "location_not_found");
    try {
      const client = new GHLClient(location.company_id, session.locationId);
      const res = await client.get<{
        user?: { phone?: string; phoneNumber?: string; mobile?: string; phone_number?: string };
      }>(`/users/${session.userId}`);
      const u = res.user || {};
      phone = u.phone || u.phoneNumber || u.mobile || u.phone_number || null;
    } catch (err) {
      console.error("[simulate-rule] failed to fetch GHL user:", err instanceof Error ? err.message : err);
    }
  }
  if (!phone) {
    return errorResponse(
      "Não consegui achar teu phone no GHL. Use o campo override no UI.",
      400, "no_phone",
    );
  }

  const rep = await identifyRep(normalizePhone(phone));
  if (!rep) {
    return errorResponse(`Nenhum user GHL com phone ${phone}`, 404, "rep_not_found");
  }
  if (!rep.terms_accepted_at) {
    await acceptTerms(rep.id);
    rep.terms_accepted_at = new Date().toISOString();
  }

  // Dispatch com forceFire (bypass cooldown/quiet hours pra teste)
  const result = await dispatchRule({
    rule: rule as Parameters<typeof dispatchRule>[0]["rule"],
    rep,
    contextData: mockContext,
    mode: "simulated",
    testSessionId: sessionId,
    forceFire: true,
  });

  return NextResponse.json({
    status: result.status,
    rule_name: rule.name,
    text_generated: result.text_generated,
    tools_used: result.tools_used,
    tokens: result.tokens,
    duration_ms: result.duration_ms,
  });
}
