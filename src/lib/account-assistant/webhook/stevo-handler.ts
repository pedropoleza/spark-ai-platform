/**
 * Handler do RECEBIMENTO via webhook do Stevo (canal WhatsApp direto).
 *
 * Pedro 2026-05-20: novo fluxo — recebimento vem do Stevo DIRETO (webhook do
 * GHL vira fallback). Este handler é o orquestrador do path Stevo: recebe o
 * `ParsedStevoMessage` (já puro, vindo de stevo-parser.ts) e:
 *   1. Resolve o hub ativo (resolvePrimaryHub) → locationId + agentId.
 *   2. Identifica o rep pelo telefone (identifyRep).
 *   3. Dedup por messageId (findByGhlMessageId em sparkbot_messages).
 *   4. Monta o RepInput (texto direto; doc/imagem via processFile a partir do
 *      base64 decriptado; áudio via transcribeAudioFromBuffer).
 *   5. Chama processIncoming (channel "whatsapp").
 *   6. Persiste o turno (user + agent) em sparkbot_messages.
 *
 * ⚠️ FASE 1: NÃO ENVIA a resposta via Stevo ainda — só processa, persiste e
 * loga. O envio (Stevo API /send/text) entra na FASE 2. Ver TODO abaixo.
 *
 * NÃO substitui o webhook-handler.ts (path GHL) — os dois coexistem durante a
 * transição. Reusa os mesmos building blocks (identity, file-processor,
 * processor, repos) pra manter comportamento idêntico.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import { resolvePrimaryHub } from "../hub-resolver";
import { identifyRep } from "../identity";
import { processFile } from "../file-processor";
import { processIncoming } from "../processor";
import { transcribeAudioFromBuffer } from "@/lib/ai/audio-transcriber";
import {
  findByGhlMessageId,
  insertSparkbotMessage,
  getSparkbotHistory,
} from "@/lib/repositories/sparkbot-messages.repo";
import type { ParsedStevoMessage } from "./stevo-parser";
import { sendStevoText, type StevoSendResult } from "./stevo-send";

const SPARKBOT_HISTORY_TURNS = 30;

/** Gate do envio via Stevo (fase 2). Default OFF — ligar só no cutover. */
function isStevoSendEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.STEVO_SEND_ENABLED?.trim() || "");
}

/**
 * Constrói o RepInput a partir do conteúdo parseado do Stevo. O binário já
 * vem decriptado em base64 (doc/imagem/áudio), então convertemos pra Buffer e
 * reusamos os mesmos parsers do painel web / webhook GHL.
 *
 * Retorna `null` se o conteúdo não pôde ser convertido (ex: file-processor
 * rejeitou o tipo, transcrição falhou). Caller decide abortar nesse caso —
 * na fase 1 não respondemos erro pro rep ainda.
 */
async function buildRepInput(parsed: ParsedStevoMessage): Promise<RepInput | null> {
  if (parsed.kind === "text") {
    return { kind: "text", text: parsed.text };
  }

  if (parsed.kind === "audio") {
    try {
      const buffer = Buffer.from(parsed.base64, "base64");
      const { text } = await transcribeAudioFromBuffer(buffer, parsed.mimetype);
      return { kind: "audio", transcribed_text: text };
    } catch (err) {
      console.warn(
        "[stevo-handler] transcrição de áudio falhou:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  // document | image → buffer decriptado → file-processor unificado.
  try {
    const buffer = Buffer.from(parsed.base64, "base64");
    const result = await processFile({
      buffer,
      mime: parsed.mimetype,
      filename:
        parsed.kind === "document" ? parsed.fileName || "arquivo" : "imagem",
    });
    // Anexa o caption do Stevo (rep pode mandar texto junto do arquivo/imagem).
    const caption = parsed.caption || undefined;
    const repInput = result.repInput;
    if (
      repInput.kind === "image" ||
      repInput.kind === "document" ||
      repInput.kind === "tabular"
    ) {
      return { ...repInput, caption };
    }
    return repInput;
  } catch (err) {
    // file-processor lança FileProcessError com `code` user-friendly em alguns
    // casos (HEIC, PDF vazio, file too large). Na fase 1 só logamos — o envio
    // dessas mensagens de erro pro rep entra na fase 2.
    const code = (err as { code?: string })?.code;
    console.warn(
      `[stevo-handler] processFile falhou (code=${code ?? "?"}):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Snapshot textual do input do rep pra persistir em sparkbot_messages.content.
 * Mesma convenção do webhook-handler.ts (emoji por tipo, nunca content="").
 */
function userMsgContent(input: RepInput): string {
  if (input.kind === "text") return input.text.trim() || "[mensagem vazia]";
  if (input.kind === "audio") return `🎤 "${input.transcribed_text}"`;
  if (input.kind === "image") return input.caption || "[imagem]";
  if (input.kind === "document") {
    return `📎 ${input.filename}${input.extracted_text ? `\n${input.extracted_text.substring(0, 500)}` : ""}`;
  }
  if (input.kind === "tabular") {
    return `📊 ${input.tabular.filename} (${input.tabular.total_rows} linhas)${input.caption ? `\n${input.caption}` : ""}`;
  }
  return "(input)";
}

/**
 * Processa um inbound do Stevo. Idempotente por messageId. Não lança — captura
 * tudo e loga; o caller chama via waitUntil e sempre responde 200 pro Stevo.
 */
export async function handleStevoInbound(parsed: ParsedStevoMessage): Promise<void> {
  // 1. Resolve o hub ativo (locationId + agentId).
  const hub = await resolvePrimaryHub();
  if (!hub || !hub.locationId) {
    console.error("[stevo-handler] nenhum hub Sparkbot ativo — abortando.");
    return;
  }
  const { locationId: hubLocationId, agentId } = hub;
  if (!agentId) {
    // resolvePrimaryHub pode cair no fallback env (agentId vazio). Sem agentId
    // não conseguimos cobrar/logar corretamente — aborta com log claro.
    console.error(
      `[stevo-handler] hub ${hubLocationId} sem agentId resolvido (fallback env?) — abortando.`,
    );
    return;
  }

  // 2. Dedup upfront por messageId (retry do Stevo com mesmo ID não reprocessa).
  try {
    const existing = await findByGhlMessageId(parsed.messageId);
    if (existing) {
      console.log(
        `[stevo-handler] dedupe: messageId ${parsed.messageId} já processado — skipping`,
      );
      return;
    }
  } catch (err) {
    console.warn(
      "[stevo-handler] dedup lookup falhou — segue (UNIQUE constraint pega):",
      err instanceof Error ? err.message : err,
    );
  }

  // 3. Identifica o rep pelo telefone (busca ou cria).
  const rep = await identifyRep(parsed.phone);
  if (!rep) {
    console.warn(
      `[stevo-handler] telefone ${parsed.phone} não cadastrado em nenhuma location — ignorando (fase 1 não envia aviso).`,
    );
    return;
  }

  // 4. Monta o RepInput multimodal.
  const repInput = await buildRepInput(parsed);
  if (!repInput) {
    console.warn(
      `[stevo-handler] não consegui montar RepInput pra messageId ${parsed.messageId} (kind=${parsed.kind}) — abortando.`,
    );
    return;
  }

  // 5. Carrega histórico recente pra processIncoming (senão bot fica amnésico).
  let conversationHistory: ConversationTurn[] = [];
  try {
    const prior = await getSparkbotHistory(rep.id, hubLocationId, SPARKBOT_HISTORY_TURNS);
    conversationHistory = prior
      .reverse()
      .filter((m) => (m.content || "").trim().length > 0)
      .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      }));
  } catch (err) {
    console.warn(
      "[stevo-handler] leitura de histórico falhou (segue sem histórico):",
      err instanceof Error ? err.message : err,
    );
  }

  // 6. Persiste a msg do rep ANTES de processar (assim se LLM crashar, o
  //    próximo turno ainda tem o histórico). Captura 23505 = dedup signal.
  const insertedUser = await insertSparkbotMessage({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: agentId,
    active_location_id: rep.active_location_id || null,
    role: "user",
    content: userMsgContent(repInput),
    channel: "whatsapp",
    ghl_message_id: parsed.messageId,
    metadata: {
      input_kind: repInput.kind,
      source: "stevo",
      push_name: parsed.pushName || null,
    },
  });
  // insertSparkbotMessage devolve null em qualquer erro (inclusive 23505). Se a
  // msg já existia (race com webhook GHL fallback), o dedup upfront geralmente
  // pega; aqui é defesa extra mas seguimos pra processar de qualquer forma —
  // pior caso, gera 1 turno duplicado raríssimo (Stevo não faz multi-provider).
  if (!insertedUser) {
    console.warn(
      `[stevo-handler] insert da user msg falhou (messageId ${parsed.messageId}) — seguindo mesmo assim.`,
    );
  }

  // Silence reset: qualquer inbound do rep limpa counter + pausa proativa.
  try {
    const supabase = createAdminClient();
    await supabase
      .from("rep_identities")
      .update({
        last_inbound_at: new Date().toISOString(),
        consecutive_proactive_without_reply: 0,
        proactive_paused_at: null,
        proactive_warned_at: null,
      })
      .eq("id", rep.id);
  } catch (err) {
    console.warn(
      "[stevo-handler] silence reset falhou (não-bloqueante):",
      err instanceof Error ? err.message : err,
    );
  }

  // 7. Processa via pipeline padrão (mesma config default do webhook GHL).
  let result;
  try {
    result = await processIncoming({
      rep,
      input: repInput,
      agentId,
      conversationHistory,
      channel: "whatsapp",
      config: {
        confirmation_mode: "high_only",
        enabled_kbs: ["national_life_group", "agency_brazillionaires"],
        enable_audio_transcription: true,
        enable_image_analysis: true,
        enable_pdf_reading: true,
      },
    });
  } catch (err) {
    console.error(
      "[stevo-handler] processIncoming lançou:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  // ===== 8. ENVIO (fase 2) — gated por STEVO_SEND_ENABLED =====
  // Default OFF: enquanto o cutover não acontece, o path Stevo só processa +
  // persiste (igual fase 1) e o envio segue saindo pelo GHL — assim deployar
  // este código NÃO muda o comportamento de prod. Quando STEVO_SEND_ENABLED=1
  // (cutover supervisionado), a resposta sai pelo Stevo, pela MESMA instância
  // que recebeu (parsed.serverUrl + parsed.instanceToken). Env é só fallback.
  const sendEnabled = isStevoSendEnabled();
  const replyText = result.text || "";
  let sendResult: StevoSendResult | null = null;

  if (sendEnabled && replyText.trim()) {
    const serverUrl = parsed.serverUrl || process.env.STEVO_API_BASE?.trim() || "";
    const apiKey =
      parsed.instanceToken ||
      process.env.STEVO_SEND_APIKEY?.trim() ||
      process.env.STEVO_INSTANCE_TOKEN?.trim() ||
      "";
    sendResult = await sendStevoText({
      serverUrl,
      apiKey,
      number: parsed.phone,
      text: replyText,
    });
    if (sendResult.ok) {
      console.log(
        `[stevo-handler] resposta enviada via Stevo pra ${parsed.phone} ` +
          `(${sendResult.sent}/${sendResult.total} bolhas).`,
      );
    } else {
      console.error(
        `[stevo-handler] envio via Stevo FALHOU pra ${parsed.phone}: ${sendResult.error} ` +
          `(${sendResult.sent}/${sendResult.total} enviadas).`,
      );
    }
  } else {
    console.log(
      `[stevo-handler] resposta gerada (envio ${sendEnabled ? "vazio" : "OFF — STEVO_SEND_ENABLED desligado"}) ` +
        `pra ${parsed.phone}: "${replyText.slice(0, 200)}"`,
    );
  }

  // 9. Persiste a resposta do agente (com o status real do envio).
  await insertSparkbotMessage({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: agentId,
    active_location_id: rep.active_location_id || null,
    role: "agent",
    content: result.text || "(sem resposta)",
    channel: "whatsapp",
    metadata: {
      source: "stevo",
      model: result.model_used,
      tools: result.tools_executed,
      prompt_tokens: result.tokens?.prompt,
      completion_tokens: result.tokens?.completion,
      cached_tokens: result.tokens?.cached,
      llm_failed: result.llm_failed,
      // Status de envio: sent_via="stevo" quando a resposta saiu de fato.
      // not_sent=true quando o gate estava off OU o envio falhou (audit claro).
      sent_via: sendResult?.ok ? "stevo" : null,
      not_sent: !sendResult?.ok,
      send_error: sendResult?.error ?? null,
      send_bubbles: sendResult ? `${sendResult.sent}/${sendResult.total}` : null,
    },
  });
}
