/**
 * POST /api/sparkbot/send
 *
 * Endpoint pro painel web mandar mensagem pro Sparkbot. Reusa o mesmo
 * processIncoming do webhook handler — diferença é só o canal:
 *   - channel='web_ui' (vs 'whatsapp')
 *   - resposta volta no JSON (não enviada via GHL conversations/messages)
 *
 * Auth: Bearer JWT emitido pelo /check-admin.
 *
 * Body: { message: string }
 * Resposta: { text, tools_executed, tokens, model_used, message_id }
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processIncoming } from "@/lib/account-assistant/processor";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import type { ConversationTurn } from "@/lib/ai/openai-client";

export const maxDuration = 60;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...CORS_HEADERS, ...(init.headers || {}) } });

  // 1. Auth
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const message = String(body.message || "").trim();
  if (!message) return json({ ok: false, reason: "empty_message" }, { status: 400 });

  const supabase = createAdminClient();

  // 2. Busca rep_identity completo (token só tem rep_id; processIncoming
  // precisa do objeto inteiro pra resolver active_location, ghl_users etc).
  const { data: rep } = await supabase
    .from("rep_identities")
    .select("*")
    .eq("id", tok.rep_id)
    .maybeSingle();
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  // 3. Busca agent Sparkbot do hub (mesma lógica do webhook handler)
  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  if (!hubLocationId) return json({ ok: false, reason: "hub_not_configured" }, { status: 500 });

  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id, agent_configs(confirmation_mode, ai_model)")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  if (!hubAgent) return json({ ok: false, reason: "no_sparkbot_agent" }, { status: 404 });

  const agentConfig = Array.isArray(hubAgent.agent_configs)
    ? hubAgent.agent_configs[0]
    : hubAgent.agent_configs;

  // 4. Histórico unificado: lê últimos N turns de sparkbot_messages
  // (mesma lógica do webhook handler — bot lembra do WhatsApp aqui)
  const { data: priorMsgs } = await supabase
    .from("sparkbot_messages")
    .select("role, content, created_at")
    .eq("rep_id", rep.id)
    .eq("hub_location_id", hubLocationId)
    .order("created_at", { ascending: false })
    .limit(30);

  const conversationHistory: ConversationTurn[] = (priorMsgs || [])
    .reverse()
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

  // 5. Persiste msg do user (channel='web_ui')
  const userInsert = await supabase
    .from("sparkbot_messages")
    .insert({
      rep_id: rep.id,
      hub_location_id: hubLocationId,
      agent_id: hubAgent.id,
      active_location_id: tok.location_id,
      role: "user",
      content: message,
      channel: "web_ui",
      metadata: { ghl_user_id: tok.ghl_user_id },
    })
    .select("id")
    .single();

  // 6. Heartbeat: marca que rep tá ativo no web (pra canal automático
  // decidir mandar proativos no web vs WhatsApp)
  await supabase
    .from("rep_identities")
    .update({ web_session_active_at: new Date().toISOString() })
    .eq("id", rep.id);

  // 7. Processa via Sparkbot — channel='web_ui' injetado no runtime context
  // pra prompt-builder/tools saberem o contexto.
  const startTs = Date.now();
  const result = await processIncoming({
    rep,
    input: { kind: "text", text: message },
    agentId: hubAgent.id,
    conversationHistory,
    channel: "web_ui",
    config: {
      confirmation_mode:
        (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") ||
        "medium_and_high",
      ai_model: agentConfig?.ai_model,
    },
  });
  const durationMs = Date.now() - startTs;

  // 8. Persiste resposta (channel='web_ui'); marca como já lida (foi sent
  // diretamente pro browser, não é proativa pendente)
  await supabase.from("sparkbot_messages").insert({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: hubAgent.id,
    active_location_id: tok.location_id,
    role: "agent",
    content: result.text || "(sem resposta)",
    channel: "web_ui",
    read_in_web_at: new Date().toISOString(),
    metadata: {
      model: result.model_used,
      tools: result.tools_executed,
      prompt_tokens: result.tokens?.prompt,
      completion_tokens: result.tokens?.completion,
      cached_tokens: result.tokens?.cached,
      duration_ms: durationMs,
      llm_failed: result.llm_failed,
    },
  });

  return json({
    ok: true,
    text: result.text,
    tools_executed: result.tools_executed,
    tokens: result.tokens,
    model_used: result.model_used,
    duration_ms: durationMs,
    user_message_id: userInsert.data?.id || null,
  });
}
