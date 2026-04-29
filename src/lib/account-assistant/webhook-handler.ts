/**
 * Handler do webhook do Sparkbot. Invocado pelo webhook principal
 * (/api/webhooks/inbound-message) quando locationId === ASSISTANT_HUB_LOCATION_ID.
 *
 * Não é uma rota HTTP própria — o webhook principal já fez parse, signature
 * check, rate limit, e encaminha pra cá quando detecta que a msg é pro Hub.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { identifyRep } from "./identity";
import { processIncoming } from "./processor";
import { transcribeAudioFromUrl, extractAudioUrl } from "@/lib/ai/audio-transcriber";
import { extractMediaAttachments } from "@/lib/ai/media-extractor";
import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";

const SPARKBOT_HISTORY_TURNS = 30;

export interface HandleAssistantInboundArgs {
  hubLocationId: string;
  contactId: string;
  conversationId: string;
  messageBody: string;
  messageType: string;
  direction: string;
  body: Record<string, unknown>;
}

/**
 * Processa inbound do Sparkbot. Só aceita `direction === "inbound"` — msgs
 * outbound (que nós mesmos mandamos) são ignoradas pra evitar loop.
 *
 * Retorna true se a msg foi reconhecida como do Hub e processada (ou seja,
 * o webhook principal deve parar o fluxo). Retorna false se por algum motivo
 * o handler não pôde processar e o webhook principal deve tratar como erro.
 */
export async function handleAssistantInbound(args: HandleAssistantInboundArgs): Promise<void> {
  const { hubLocationId, contactId, conversationId, messageBody, messageType, direction, body } = args;

  if (direction !== "inbound") {
    console.log(`[Sparkbot] skip outbound (type=${messageType})`);
    return;
  }

  const hubCompanyId =
    process.env.ASSISTANT_HUB_COMPANY_ID?.trim() || process.env.NEXT_PUBLIC_GHL_COMPANY_ID?.trim();
  if (!hubCompanyId) {
    console.error("[Sparkbot] ASSISTANT_HUB_COMPANY_ID não configurado");
    return;
  }

  const hubClient = new GHLClient(hubCompanyId, hubLocationId);

  // 1. Buscar contact no Hub pra pegar phone
  let phone: string | null = null;
  try {
    const contactRes = await hubClient.get<{ contact: { phone?: string } }>(`/contacts/${contactId}`);
    phone = contactRes.contact?.phone || null;
  } catch (err) {
    console.error("[Sparkbot] failed to fetch hub contact:", err instanceof Error ? err.message : err);
    return;
  }

  if (!phone) {
    console.log(`[Sparkbot] no phone for hub contact ${contactId}, ignoring`);
    return;
  }

  // 2. Identifica rep (busca ou cria)
  const rep = await identifyRep(phone);
  if (!rep) {
    await sendResponseToRep(
      hubClient, contactId, conversationId, messageType,
      "Olá! Seu número não está cadastrado em nenhuma location. Fale com o admin da sua agência pra ser autorizado.",
    );
    return;
  }

  // 3. Extrai input multimodal
  const repInput = await extractRepInput({ body, messageBody });

  // 4. Busca agent Sparkbot na Hub (pra billing + config)
  const supabase = createAdminClient();
  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id, agent_configs(confirmation_mode, ai_model)")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();

  if (!hubAgent) {
    console.error("[Sparkbot] no active account_assistant agent in Hub location");
    await sendResponseToRep(
      hubClient, contactId, conversationId, messageType,
      "O Sparkbot não tá configurado ainda nessa location. Fala com o admin.",
    );
    return;
  }

  const agentConfig = Array.isArray(hubAgent.agent_configs)
    ? hubAgent.agent_configs[0]
    : hubAgent.agent_configs;

  // 5. Carregar histórico real da conversa do rep com o Sparkbot.
  // Antes deste fix (C2), o webhook chamava processIncoming SEM
  // conversationHistory → bot era amnésico. Synthetic-test funcionava
  // (lia agent_test_messages); produção real não.
  // Lê últimos N turns da tabela sparkbot_messages dedicada.
  // Defensivo: se tabela não existe (migration 00040 não aplicada ainda),
  // segue sem histórico. Pior caso: bot continua amnésico (estado atual).
  let priorMsgs: Array<{ role: string; content: string; created_at: string }> = [];
  try {
    const r = await supabase
      .from("sparkbot_messages")
      .select("role, content, created_at")
      .eq("rep_id", rep.id)
      .eq("hub_location_id", hubLocationId)
      .order("created_at", { ascending: false })
      .limit(SPARKBOT_HISTORY_TURNS);
    if (r.data) priorMsgs = r.data;
    if (r.error) {
      console.warn("[Sparkbot] sparkbot_messages read failed (migration pendente?):", r.error.message);
    }
  } catch (err) {
    console.warn("[Sparkbot] sparkbot_messages read crashed:", err instanceof Error ? err.message : err);
  }

  // Reverte pra ordem cronológica (oldest first) e mapeia pra ConversationTurn.
  const conversationHistory: ConversationTurn[] = priorMsgs
    .reverse()
    .map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));

  // Persiste a msg do rep ANTES de processar (assim se LLM crashar, o
  // próximo turno ainda tem o histórico completo).
  const userMsgContent =
    repInput.kind === "audio"
      ? `🎤 "${repInput.transcribed_text}"`
      : repInput.kind === "image"
      ? repInput.caption || "[imagem]"
      : repInput.kind === "document"
      ? `📎 ${repInput.filename}${repInput.extracted_text ? `\n${repInput.extracted_text.substring(0, 500)}` : ""}`
      : repInput.text;

  // Defensivo: tabela pode não existir; não queremos quebrar webhook.
  try {
    await supabase.from("sparkbot_messages").insert({
      rep_id: rep.id,
      hub_location_id: hubLocationId,
      agent_id: hubAgent.id,
      active_location_id: rep.active_location_id || null,
      role: "user",
      content: userMsgContent,
      channel: "whatsapp",
      metadata: { input_kind: repInput.kind, ghl_contact_id: contactId },
    });
  } catch (err) {
    console.warn("[Sparkbot] sparkbot_messages insert (user) failed:", err instanceof Error ? err.message : err);
  }

  // 6. Processa
  const result = await processIncoming({
    rep,
    input: repInput,
    agentId: hubAgent.id,
    conversationHistory,
    channel: "whatsapp",
    config: {
      confirmation_mode:
        (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") ||
        "medium_and_high",
      ai_model: agentConfig?.ai_model,
    },
  });

  if (result.should_send && result.text) {
    await sendResponseToRep(hubClient, contactId, conversationId, messageType, result.text);
  }

  // Persiste resposta do agente (defensivo)
  try {
    await supabase.from("sparkbot_messages").insert({
      rep_id: rep.id,
      hub_location_id: hubLocationId,
      agent_id: hubAgent.id,
      active_location_id: rep.active_location_id || null,
      role: "agent",
      content: result.text || "(sem resposta)",
      channel: "whatsapp",
      metadata: {
        model: result.model_used,
        tools: result.tools_executed,
        prompt_tokens: result.tokens?.prompt,
        completion_tokens: result.tokens?.completion,
        cached_tokens: result.tokens?.cached,
        llm_failed: result.llm_failed,
      },
    });
  } catch (err) {
    console.warn("[Sparkbot] sparkbot_messages insert (agent) failed:", err instanceof Error ? err.message : err);
  }

  // 7. Log execution
  await supabase.from("execution_log").insert({
    agent_id: hubAgent.id,
    location_id: hubLocationId,
    contact_id: contactId,
    action_type: "account_assistant_turn",
    action_payload: {
      rep_id: rep.id,
      input_kind: repInput.kind,
      model: result.model_used,
      tools: result.tools_executed,
      prompt_tokens: result.tokens?.prompt,
      completion_tokens: result.tokens?.completion,
      cached_tokens: result.tokens?.cached,
    },
    success: true,
  });
}

/** Extrai RepInput do webhook body (áudio → whisper, imagem → base64, doc → extract). */
async function extractRepInput(args: {
  body: Record<string, unknown>;
  messageBody: string;
}): Promise<RepInput> {
  const { body, messageBody } = args;

  const audioInfo = extractAudioUrl(body);
  if (audioInfo?.url) {
    try {
      const transcribed = await transcribeAudioFromUrl(audioInfo.url);
      if (transcribed?.text) {
        return { kind: "audio", transcribed_text: transcribed.text, original_url: audioInfo.url };
      }
    } catch (err) {
      console.warn("[Sparkbot] audio transcription failed:", err instanceof Error ? err.message : err);
    }
  }

  const attachments = extractMediaAttachments(body);
  if (attachments.length > 0) {
    try {
      const { processMediaAttachments } = await import("@/lib/ai/media-processor");
      const processed = await processMediaAttachments(attachments);

      const image = processed.find((p) => p.type === "image" && p.base64DataUri);
      if (image?.base64DataUri) {
        return {
          kind: "image",
          base64_data_uri: image.base64DataUri,
          caption: messageBody || undefined,
        };
      }

      const doc = processed.find((p) => p.type === "document" && p.extractedText);
      if (doc?.extractedText) {
        return {
          kind: "document",
          extracted_text: doc.extractedText,
          filename: doc.fileName || "documento",
        };
      }
    } catch (err) {
      console.warn("[Sparkbot] media processing failed:", err instanceof Error ? err.message : err);
    }
  }

  return { kind: "text", text: messageBody };
}

/** Envia resposta pro rep via GHL (WhatsApp dentro de 24h, SMS fora). */
async function sendResponseToRep(
  client: GHLClient,
  contactId: string,
  conversationId: string,
  incomingType: string,
  text: string,
): Promise<void> {
  const tryType = incomingType.toUpperCase().includes("WHATSAPP") ? "WhatsApp" : "SMS";
  const payload: Record<string, unknown> = {
    type: tryType,
    contactId,
    message: text,
  };
  if (conversationId) payload.conversationId = conversationId;

  try {
    await client.post("/conversations/messages", payload);
  } catch (err) {
    console.warn(
      "[Sparkbot] send failed on", tryType, "— trying fallback:",
      err instanceof Error ? err.message : err,
    );
    try {
      await client.post("/conversations/messages", {
        type: tryType === "WhatsApp" ? "SMS" : "WhatsApp",
        contactId,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
    } catch (err2) {
      console.error("[Sparkbot] send fallback also failed:", err2 instanceof Error ? err2.message : err2);
    }
  }
}
