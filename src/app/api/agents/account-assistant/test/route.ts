import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { identifyRep, normalizePhone, acceptTerms } from "@/lib/account-assistant/identity";
import { processIncoming } from "@/lib/account-assistant/processor";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import type { RepInput } from "@/types/account-assistant";

/**
 * Teste do Sparkbot via dashboard. Permite admin validar o pipeline sem
 * precisar do número WhatsApp real. Identifica o rep pelo phone do GHL user
 * logado (ou phone explícito no body).
 *
 * POST body: { message, input_kind?, base64?, filename?, auto_accept_terms? }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json();
  const message: string = body.message || "";
  const inputKind: "text" | "audio" | "image" | "document" = body.input_kind || "text";
  const base64: string | undefined = body.base64;
  const filename: string | undefined = body.filename;
  const autoAcceptTerms: boolean = body.auto_accept_terms !== false; // default true pra teste

  if (!message && inputKind === "text") {
    return errorResponse("message obrigatória", 400, "missing_message");
  }

  // Resolver phone: do body (override) ou busca GHL user logado
  let phone: string | null = body.rep_phone || null;
  let ghlUserRaw: unknown = null;
  if (!phone) {
    const { data: location } = await createAdminClient()
      .from("locations")
      .select("company_id")
      .eq("location_id", session.locationId)
      .maybeSingle();
    if (!location) return errorResponse("Location não encontrada", 404, "location_not_found");

    try {
      const client = new GHLClient(location.company_id, session.locationId);
      const res = await client.get<{
        user?: {
          phone?: string;
          phoneNumber?: string;
          mobile?: string;
          phone_number?: string;
        };
      }>(`/users/${session.userId}`);
      ghlUserRaw = res;
      const u = res.user || {};
      phone = u.phone || u.phoneNumber || u.mobile || u.phone_number || null;
    } catch (err) {
      console.error("[sparkbot test] failed to fetch GHL user:", err instanceof Error ? err.message : err);
      ghlUserRaw = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (!phone) {
    return NextResponse.json(
      {
        error:
          "Não consegui achar teu phone no GHL. Passa rep_phone no body ou configura phone no teu user no GHL.",
        code: "no_phone",
        debug: {
          session_user_id: session.userId,
          session_location_id: session.locationId,
          ghl_user_response: ghlUserRaw,
        },
      },
      { status: 400 },
    );
  }

  const rep = await identifyRep(normalizePhone(phone));
  if (!rep) {
    return errorResponse(
      `Nenhum user GHL com phone ${phone} em nenhuma location. Ou teu phone no GHL não bate, ou não tem nenhuma location registrada.`,
      404,
      "rep_not_found",
    );
  }

  // Auto-aceite termos pro teste (admin não quer passar por onboarding toda vez)
  if (autoAcceptTerms && !rep.terms_accepted_at) {
    await acceptTerms(rep.id);
    rep.terms_accepted_at = new Date().toISOString();
  }

  // Buscar agent Sparkbot
  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  if (!hubLocationId) return errorResponse("Hub não configurado", 500, "hub_not_configured");

  const supabase = createAdminClient();
  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id, agent_configs(confirmation_mode, ai_model)")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();

  if (!hubAgent) {
    return errorResponse("Sparkbot não está ativo no Hub", 404, "sparkbot_inactive");
  }
  const agentConfig = Array.isArray(hubAgent.agent_configs)
    ? hubAgent.agent_configs[0]
    : hubAgent.agent_configs;

  // Montar RepInput
  const repInput: RepInput = buildRepInput(inputKind, message, base64, filename);

  const startTs = Date.now();
  const result = await processIncoming({
    rep,
    input: repInput,
    agentId: hubAgent.id,
    config: {
      confirmation_mode: (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") || "medium_and_high",
      ai_model: agentConfig?.ai_model,
    },
  });
  const durationMs = Date.now() - startTs;

  return NextResponse.json({
    response: result.text,
    tokens: result.tokens,
    tools_executed: result.tools_executed,
    model_used: result.model_used,
    duration_ms: durationMs,
    rep: {
      id: rep.id,
      phone: rep.phone,
      display_name: rep.display_name,
      ghl_users: rep.ghl_users,
      active_location_id: rep.active_location_id,
    },
  });
}

function buildRepInput(
  kind: "text" | "audio" | "image" | "document",
  message: string,
  base64?: string,
  filename?: string,
): RepInput {
  if (kind === "audio") {
    return { kind: "audio", transcribed_text: message };
  }
  if (kind === "image" && base64) {
    return { kind: "image", base64_data_uri: base64, caption: message || undefined };
  }
  if (kind === "document" && base64) {
    return { kind: "document", extracted_text: message, filename: filename || "documento" };
  }
  return { kind: "text", text: message };
}
