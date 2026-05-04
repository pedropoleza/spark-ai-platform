import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { identifyRep, normalizePhone, acceptTerms } from "@/lib/account-assistant/identity";
import { processIncoming } from "@/lib/account-assistant/processor";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";

/**
 * POST /api/agents/account-assistant/test
 *
 * Teste do Sparkbot via dashboard. Mesmo padrão do /api/agents/test do
 * sales/recruitment: DB (agent_test_sessions/messages) é source of truth do
 * histórico. UI manda session_id + message; backend lê histórico completo
 * do DB antes de chamar o LLM.
 *
 * Body: { message, session_id?, input_kind?, base64?, filename?, rep_phone?,
 *         auto_accept_terms? }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await request.json();
  const message: string = body.message || "";
  const providedSessionId: string | undefined = body.session_id;
  const inputKind: "text" | "audio" | "image" | "document" = body.input_kind || "text";
  const base64: string | undefined = body.base64;
  const filename: string | undefined = body.filename;
  const autoAcceptTerms: boolean = body.auto_accept_terms !== false;

  if (!message && inputKind === "text") {
    return errorResponse("message obrigatória", 400, "missing_message");
  }

  // Resolver phone (body ou GHL user logado)
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
        user?: { phone?: string; phoneNumber?: string; mobile?: string; phone_number?: string };
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
        error: "Não consegui achar teu phone no GHL. Passa rep_phone no body ou configura phone no teu user no GHL.",
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
      `Nenhum user GHL com phone ${phone} em nenhuma location.`,
      404,
      "rep_not_found",
    );
  }

  if (autoAcceptTerms && !rep.terms_accepted_at) {
    await acceptTerms(rep.id);
    rep.terms_accepted_at = new Date().toISOString();
  }

  // Sparkbot agent
  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  if (!hubLocationId) return errorResponse("Hub não configurado", 500, "hub_not_configured");

  const supabase = createAdminClient();
  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();

  if (!hubAgent) {
    return errorResponse("Sparkbot não está ativo no Hub", 404, "sparkbot_inactive");
  }
  const { data: agentConfig } = await supabase
    .from("agent_configs")
    .select("*")
    .eq("agent_id", hubAgent.id)
    .maybeSingle();

  // ==========================================================================
  // 1. RESOLVER SESSÃO: existente ou nova. DB = source of truth.
  // ==========================================================================
  let sessionId: string;
  if (providedSessionId) {
    const { data: existingSession } = await supabase
      .from("agent_test_sessions")
      .select("id")
      .eq("id", providedSessionId)
      .eq("location_id", session.locationId)
      .eq("agent_id", hubAgent.id)
      .maybeSingle();
    if (!existingSession) {
      return errorResponse("Sessão não encontrada", 404, "session_not_found");
    }
    sessionId = existingSession.id;
  } else {
    const { data: newSession, error: newSessionErr } = await supabase
      .from("agent_test_sessions")
      .insert({
        agent_id: hubAgent.id,
        location_id: session.locationId,
        created_by: session.userId || "unknown",
        session_name: null,
      })
      .select("id")
      .single();
    if (newSessionErr || !newSession) {
      return errorResponse(newSessionErr?.message || "Falha ao criar sessão", 500, "session_create_failed");
    }
    sessionId = newSession.id;
  }

  // ==========================================================================
  // 2. SALVAR USER MSG
  // ==========================================================================
  const displayContent = buildDisplayContent(inputKind, message, filename);
  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "user",
    content: displayContent,
  });

  // ==========================================================================
  // 3. LER HISTÓRICO COMPLETO DO DB (últimas 30 msgs, menos a que acabou de ser inserida)
  // ==========================================================================
  const { data: dbMessages } = await supabase
    .from("agent_test_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  const allMessages = dbMessages || [];
  const priorMessages = allMessages.slice(0, -1).slice(-30);
  const conversationTurns: ConversationTurn[] = priorMessages.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  // ==========================================================================
  // 4. PROCESSAR
  // ==========================================================================
  const repInput: RepInput = buildRepInput(inputKind, message, base64, filename);

  const startTs = Date.now();
  const result = await processIncoming({
    rep,
    input: repInput,
    agentId: hubAgent.id,
    conversationHistory: conversationTurns,
    testSessionId: sessionId,
    config: {
      confirmation_mode: (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") || "high_only",
      ai_model: agentConfig?.ai_model,
      fallback_model: agentConfig?.fallback_model || null,
      custom_instructions: agentConfig?.custom_instructions || null,
      knowledge_base_instructions: agentConfig?.knowledge_base_instructions || null,
      disabled_tools: Array.isArray(agentConfig?.disabled_tools) ? agentConfig.disabled_tools : [],
      enabled_kbs: Array.isArray(agentConfig?.enabled_kbs)
        ? agentConfig.enabled_kbs
        : ["national_life_group", "agency_brazillionaires"],
      tone_creativity: agentConfig?.tone_creativity ?? null,
      tone_formality: agentConfig?.tone_formality ?? null,
      tone_naturalness: agentConfig?.tone_naturalness ?? null,
      tone_aggressiveness: agentConfig?.tone_aggressiveness ?? null,
      enable_audio_transcription: agentConfig?.enable_audio_transcription ?? true,
      enable_image_analysis: agentConfig?.enable_image_analysis ?? true,
      enable_pdf_reading: agentConfig?.enable_pdf_reading ?? true,
    },
  });
  const durationMs = Date.now() - startTs;

  // ==========================================================================
  // 5. SALVAR AGENT MSG + ATUALIZAR updated_at DA SESSÃO
  // ==========================================================================
  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "agent",
    content: result.text || "(sem resposta)",
    metadata: {
      model: result.model_used,
      tools: result.tools_executed,
      tool_calls: result.tool_calls, // inclui input + result pra debug
      prompt_tokens: result.tokens?.prompt,
      completion_tokens: result.tokens?.completion,
      cached_tokens: result.tokens?.cached,
      duration_ms: durationMs,
      llm_failed: result.llm_failed || false, // pra detection de loop no próximo turn
    },
  });
  await supabase
    .from("agent_test_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  return NextResponse.json({
    session_id: sessionId,
    response: result.text,
    tokens: result.tokens,
    tools_executed: result.tools_executed,
    tool_calls: result.tool_calls, // detalhes completos pra debug no UI
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
  if (kind === "audio") return { kind: "audio", transcribed_text: message };
  if (kind === "image" && base64) return { kind: "image", base64_data_uri: base64, caption: message || undefined };
  if (kind === "document" && base64) return { kind: "document", extracted_text: message, filename: filename || "documento" };
  return { kind: "text", text: message };
}

/** Rótulo amigável pra salvar na DB (a msg do rep como aparece na UI). */
function buildDisplayContent(
  kind: "text" | "audio" | "image" | "document",
  message: string,
  filename?: string,
): string {
  if (kind === "audio") return `🎤 "${message}"`;
  if (kind === "image") return message || "[imagem anexada]";
  if (kind === "document") return `📎 ${filename || "documento"}${message ? `\n${message}` : ""}`;
  return message;
}
