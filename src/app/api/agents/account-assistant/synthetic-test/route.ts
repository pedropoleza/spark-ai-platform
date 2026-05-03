import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { identifyRep, normalizePhone, acceptTerms } from "@/lib/account-assistant/identity";
import { processIncoming } from "@/lib/account-assistant/processor";
import { errorResponse } from "@/lib/utils/api";
import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";

/**
 * POST /api/agents/account-assistant/synthetic-test
 *
 * Endpoint usado pelo ultra-review pra rodar conversas sintéticas com o
 * Sparkbot sem precisar de cookie de admin. Auth via Bearer CRON_SECRET.
 *
 * Body: {
 *   message: string,
 *   session_id?: string,           // se omitido, cria nova
 *   rep_phone: string,             // phone E.164 (deve existir como GHL user em alguma location)
 *   input_kind?: "text"|"audio"|"image"|"document",
 *   base64?: string,
 *   filename?: string,
 *   reset?: boolean,               // se true, deleta a sessão antes de criar nova
 * }
 *
 * Retorna: response, tools_executed, tool_calls (debug completo), tokens,
 * model_used, duration_ms, session_id pra encadear próxima msg.
 *
 * IMPORTANTE: este endpoint executa AÇÕES REAIS no GHL se o LLM chamar tools
 * de escrita. Use rep_phone que aponta pra location dummy pra evitar lixo.
 */
export async function POST(request: NextRequest) {
  // Auth via Bearer (mesma key dos crons)
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return errorResponse("CRON_SECRET não configurado", 500, "no_secret");
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return errorResponse("Bearer auth required", 401, "unauthorized");
  }

  const body = await request.json();
  const message: string = body.message || "";
  const sessionIdProvided: string | undefined = body.session_id;
  const repPhone: string | undefined = body.rep_phone;
  const inputKind: "text" | "audio" | "image" | "document" = body.input_kind || "text";
  const base64: string | undefined = body.base64;
  const filename: string | undefined = body.filename;
  const reset: boolean = body.reset === true;

  if (!message && inputKind === "text") {
    return errorResponse("message obrigatória pra input_kind=text", 400, "missing_message");
  }
  if (!repPhone) {
    return errorResponse("rep_phone obrigatório", 400, "missing_phone");
  }

  // Identifica rep
  const rep = await identifyRep(normalizePhone(repPhone));
  if (!rep) {
    return errorResponse(
      `Nenhum GHL user com phone ${repPhone}. Cadastre primeiro num GHL location.`,
      404,
      "rep_not_found",
    );
  }
  if (!rep.terms_accepted_at) {
    await acceptTerms(rep.id);
    rep.terms_accepted_at = new Date().toISOString();
  }

  // Sparkbot agent
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
  if (!hubAgent) return errorResponse("Sparkbot inativo no Hub", 404, "no_sparkbot");
  const agentConfig = Array.isArray(hubAgent.agent_configs)
    ? hubAgent.agent_configs[0]
    : hubAgent.agent_configs;

  // Sessão sintética. Pra reuso entre msgs do mesmo cenário, mantém
  // session_id. Reset opt-in deleta antes de criar.
  let sessionId: string;
  if (reset && sessionIdProvided) {
    await supabase.from("agent_test_sessions").delete().eq("id", sessionIdProvided);
  }

  if (sessionIdProvided && !reset) {
    const { data: existing } = await supabase
      .from("agent_test_sessions")
      .select("id")
      .eq("id", sessionIdProvided)
      .maybeSingle();
    if (!existing) {
      return errorResponse("Sessão fornecida não existe", 404, "session_not_found");
    }
    sessionId = existing.id;
  } else {
    const { data: newSess } = await supabase
      .from("agent_test_sessions")
      .insert({
        agent_id: hubAgent.id,
        location_id: hubLocationId, // pra ultra-review usa Hub mesmo
        created_by: "synthetic-test",
        session_name: `synthetic-${new Date().toISOString().slice(0, 19)}`,
      })
      .select("id")
      .single();
    if (!newSess) return errorResponse("Falha ao criar sessão", 500, "session_create_failed");
    sessionId = newSess.id;
  }

  // Salva user msg
  const displayContent =
    inputKind === "audio"
      ? `🎤 "${message}"`
      : inputKind === "image"
      ? message || "[imagem]"
      : inputKind === "document"
      ? `📎 ${filename || "documento"}${message ? `\n${message}` : ""}`
      : message;

  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "user",
    content: displayContent,
  });

  // Histórico do DB
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

  // Build RepInput
  const repInput: RepInput =
    inputKind === "audio"
      ? { kind: "audio", transcribed_text: message }
      : inputKind === "image" && base64
      ? { kind: "image", base64_data_uri: base64, caption: message || undefined }
      : inputKind === "document" && base64
      ? { kind: "document", extracted_text: message, filename: filename || "documento" }
      : { kind: "text", text: message };

  const startTs = Date.now();
  const result = await processIncoming({
    rep,
    input: repInput,
    agentId: hubAgent.id,
    conversationHistory: conversationTurns,
    testSessionId: sessionId,
    config: {
      confirmation_mode:
        (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") || "high_only",
      ai_model: agentConfig?.ai_model,
    },
  });
  const durationMs = Date.now() - startTs;

  // Salva agent msg
  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "agent",
    content: result.text || "(sem resposta)",
    metadata: {
      model: result.model_used,
      tools: result.tools_executed,
      tool_calls: result.tool_calls,
      prompt_tokens: result.tokens?.prompt,
      completion_tokens: result.tokens?.completion,
      cached_tokens: result.tokens?.cached,
      duration_ms: durationMs,
      synthetic: true,
    },
  });
  await supabase
    .from("agent_test_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  return NextResponse.json({
    session_id: sessionId,
    rep_id: rep.id,
    response: result.text,
    tools_executed: result.tools_executed,
    tool_calls: result.tool_calls,
    tokens: result.tokens,
    model_used: result.model_used,
    duration_ms: durationMs,
  });
}
