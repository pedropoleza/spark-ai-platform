import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { GHLClient } from "@/lib/ghl/client";
import { buildFollowUpPrompt } from "@/lib/ai/sales-prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";

/**
 * POST /api/agents/test/followup
 *
 * Gera uma prévia de mensagem de follow-up para o admin visualizar antes de
 * deixar o cron real disparar em produção. NÃO salva em agent_test_messages
 * automaticamente — a UI decide se adiciona à conversa depois.
 *
 * Body: { agent_id, session_id?, attempt_number, contact_id? }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const { agent_id, session_id, attempt_number, contact_id } = body;

  if (!agent_id || !attempt_number || typeof attempt_number !== "number") {
    return NextResponse.json({ error: "agent_id e attempt_number obrigatorios" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("*, agent_configs(*)")
    .eq("id", agent_id)
    .eq("location_id", session.locationId)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agente nao encontrado" }, { status: 404 });
  }

  const config = Array.isArray(agent.agent_configs)
    ? agent.agent_configs[0]
    : agent.agent_configs;

  if (!config) {
    return NextResponse.json({ error: "Agente sem configuracao" }, { status: 400 });
  }

  const { data: location } = await supabase
    .from("locations")
    .select("*")
    .eq("location_id", session.locationId)
    .single();

  // Caso manual: pega a custom_message configurada no step, sem IA.
  const followUpConfig = config.follow_up_config;
  if (followUpConfig?.mode === "manual" && Array.isArray(followUpConfig.manual_steps)) {
    const step = followUpConfig.manual_steps[attempt_number - 1];
    if (step?.custom_message) {
      return NextResponse.json({
        message: step.custom_message,
        mode: "manual",
        attempt_number,
        duration_ms: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      });
    }
    if (step && !step.custom_message) {
      return NextResponse.json(
        { error: `Passo manual #${attempt_number} não tem custom_message definido` },
        { status: 400 },
      );
    }
  }

  // Caso AI_AUTO: busca histórico da sessão + contato GHL e gera via IA.
  let recentHistory = "";
  let sessionCollectedData: Record<string, string> = {};

  if (session_id) {
    const { data: testSession } = await supabase
      .from("agent_test_sessions")
      .select("collected_data, contact_id")
      .eq("id", session_id)
      .eq("location_id", session.locationId)
      .maybeSingle();
    if (testSession) {
      sessionCollectedData = (testSession.collected_data as Record<string, string>) || {};
    }

    const { data: dbMessages } = await supabase
      .from("agent_test_messages")
      .select("role, content, created_at")
      .eq("session_id", session_id)
      .order("created_at", { ascending: true });

    const msgs = dbMessages || [];
    recentHistory = msgs
      .slice(-10)
      .map((m) => {
        const dir = m.role === "user" ? "LEAD" : "AGENTE";
        return `${dir}: ${(m.content || "").substring(0, 300)}`;
      })
      .join("\n");
  }

  // Contato GHL (pra pegar nome real)
  let contactName: string | undefined;
  if (contact_id) {
    try {
      const ghlClient = new GHLClient(session.companyId, session.locationId);
      const contactResult = await ghlClient.get<{ contact: { firstName?: string; name?: string } }>(
        `/contacts/${contact_id}`,
      );
      contactName = contactResult.contact?.name || contactResult.contact?.firstName || undefined;
    } catch {
      // Segue sem o nome — não é crítico pro preview
    }
  }

  // Se não temos nome via GHL, tenta pegar do collected_data da sessão
  if (!contactName) {
    contactName = sessionCollectedData["contact.name"] || sessionCollectedData["full_name"];
  }

  const followUpPrompt = buildFollowUpPrompt({
    config,
    agentType: agent.type as "sales_agent" | "recruitment_agent",
    attemptNumber: attempt_number,
    locationName: location?.location_name || "Nossa empresa",
    currentDate: new Date().toLocaleDateString("pt-BR"),
    timezone: location?.timezone || "America/New_York",
    contactName,
    collectedData: sessionCollectedData,
    recentHistory,
  });

  const result = await processWithAI({
    systemPrompt: followUpPrompt,
    conversationHistory: "",
    newMessages: `Follow-up #${attempt_number} para o lead. Gere UMA unica mensagem de follow-up.`,
    model: config.ai_model || "gpt-4.1-mini",
  });

  if (!result.success || !result.response) {
    return NextResponse.json(
      { error: result.error || "Falha ao gerar follow-up" },
      { status: 500 },
    );
  }

  const message = Array.isArray(result.response.message)
    ? result.response.message.join("\n")
    : result.response.message;

  return NextResponse.json({
    message,
    mode: "ai_auto",
    attempt_number,
    duration_ms: result.duration_ms,
    prompt_tokens: result.prompt_tokens,
    completion_tokens: result.completion_tokens,
  });
}
