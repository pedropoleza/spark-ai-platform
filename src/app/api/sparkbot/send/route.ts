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
import { corsHeadersFor } from "@/lib/utils/cors";
import { resolvePrimaryHub, getEnvHubLocationId } from "@/lib/account-assistant/hub-resolver";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import type { RepInput } from "@/types/account-assistant";
import { findRepById, updateRepById } from "@/lib/repositories/rep-identities.repo";
import { getSparkbotHistory, insertSparkbotMessage } from "@/lib/repositories/sparkbot-messages.repo";
import { reportError } from "@/lib/admin-signals/report-error";
import { findActiveSparkbotAgent, findAgentConfig } from "@/lib/repositories/agents.repo";

export const maxDuration = 60;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeadersFor(request, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request, "POST, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...corsHeaders, ...(init.headers || {}) } });

  // 1. Auth
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const message = String(body.message || "").trim();
  // Attachment opcional vindo do POST /upload — Painel guarda e manda no
  // próximo /send. Tipo é RepInput não-text/audio (image/document/tabular).
  let attachment = body.attachment as RepInput | undefined;
  if (!message && !attachment) {
    return json({ ok: false, reason: "empty_message_and_attachment" }, { status: 400 });
  }
  // True quando o anexo foi recuperado do cache (não foi enviado nesta turn).
  // Usado pra ajustar o `persistContent` — não queremos repetir o ícone no
  // histórico cada vez que o user só responde "sim", mas as tools precisam
  // ver os rows.
  let attachmentRestoredFromCache = false;

  const supabase = createAdminClient();

  // 2. Busca rep_identity completo (token só tem rep_id; processIncoming
  // precisa do objeto inteiro pra resolver active_location, ghl_users etc).
  const rep = await findRepById(tok.rep_id);
  if (!rep) return json({ ok: false, reason: "rep_not_found" }, { status: 404 });

  // 3. Busca agent Sparkbot do hub — H29 2026-05-20: DB-first com fallback env
  const hubEntry = await resolvePrimaryHub();
  const hubLocationId = hubEntry?.locationId ?? getEnvHubLocationId();
  if (!hubLocationId) return json({ ok: false, reason: "hub_not_configured" }, { status: 500 });

  let hubAgentId = hubEntry?.agentId || null;
  if (!hubAgentId) {
    const hubAgentRow = await findActiveSparkbotAgent(hubLocationId);
    hubAgentId = hubAgentRow?.id ?? null;
  }
  if (!hubAgentId) return json({ ok: false, reason: "no_sparkbot_agent" }, { status: 404 });
  const hubAgent = { id: hubAgentId };

  const agentConfig = await findAgentConfig(hubAgent.id);

  // 4. Histórico unificado: lê últimos N turns de sparkbot_messages
  // (mesma lógica do webhook handler — bot lembra do WhatsApp aqui)
  let priorMsgs: Array<{ role: string; content: string; created_at: string }> = [];
  try {
    priorMsgs = await getSparkbotHistory(rep.id, hubLocationId, 30);
  } catch { /* tabela ausente — segue sem hist */ }

  const conversationHistory: ConversationTurn[] = priorMsgs
    .reverse()
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

  // 4b. Anexo "sticky" — só pra tabular (CSV/XLSX), que historicamente é o
  // workflow onde o rep manda 1x e responde várias turns ("sim", "ok", "muda
  // mapping"). Sem isso o LLM virava bobo: "Reanexa o CSV" → user reanexa →
  // bot mapeia → "Sim" → "Reanexa o CSV de novo" (visto em prod 2026-04-30).
  //
  // Estratégia: se a request veio SEM attachment, busca no cache o último
  // anexo tabular do rep (TTL 30 min). Pra image/PDF mantemos comportamento
  // atual (reupload obrigatório) — esses payloads são MB-grandes (base64) e
  // não cabem no metadata sem inflar muito o DB.
  const ATTACHMENT_TTL_MIN = 30;
  if (!attachment) {
    try {
      const cutoff = new Date(Date.now() - ATTACHMENT_TTL_MIN * 60 * 1000).toISOString();
      // Busca direta (não no repo genérico — query específica de cache de attachment)
      const r = await supabase
        .from("sparkbot_messages")
        .select("metadata, created_at")
        .eq("rep_id", rep.id)
        .eq("hub_location_id", hubLocationId)
        .eq("role", "user")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(10);
      const cachedRow = (r.data || []).find((m) => {
        const meta = m.metadata as { attachment_full?: { kind?: string } } | null;
        return meta?.attachment_full?.kind === "tabular";
      });
      if (cachedRow) {
        const meta = cachedRow.metadata as { attachment_full?: RepInput };
        if (meta.attachment_full) {
          attachment = meta.attachment_full;
          attachmentRestoredFromCache = true;
          console.log(
            `[Sparkbot:send] anexo tabular recuperado do cache (rep=${rep.id}, ` +
            `idade=${Math.round((Date.now() - new Date(cachedRow.created_at as unknown as string).getTime()) / 1000)}s)`,
          );
        }
      }
    } catch (err) {
      console.warn("[Sparkbot:send] cache lookup falhou:", err instanceof Error ? err.message : err);
    }
  }

  // 5. Persiste msg do user (channel='web_ui'). Conteúdo refletindo anexo
  // pra histórico legível: "📎 lista.xlsx (47 linhas)" + caption.
  // Se anexo veio do cache (sticky tabular), NÃO repete o ícone — só mostra
  // a mensagem do user. Senão fica poluído ("📊 lista.csv" em toda turn).
  const persistContent = (() => {
    if (!attachment || attachmentRestoredFromCache) return message;
    const filename = (() => {
      if (attachment.kind === "image") return attachment.filename || "imagem";
      if (attachment.kind === "document") return attachment.filename;
      if (attachment.kind === "tabular") return attachment.tabular.filename;
      return "arquivo";
    })();
    const icon = attachment.kind === "image" ? "🖼️" : attachment.kind === "tabular" ? "📊" : "📄";
    const meta = attachment.kind === "tabular"
      ? ` (${attachment.tabular.total_rows} linhas)`
      : "";
    return `${icon} ${filename}${meta}${message ? `\n${message}` : ""}`;
  })();

  let userInsertId: string | null = null;
  try {
    // attachment_full salva o RepInput inteiro pra cache de "sticky tabular".
    // Só ativamos pra tabular (rows ≤ 500, payload ≤ ~250KB) — image/PDF são
    // base64 multi-MB e estouram o jsonb sem necessidade prática.
    // Se o anexo VEIO do cache, NÃO regravamos — preservamos o original.
    const shouldCacheAttachment =
      !!attachment &&
      attachment.kind === "tabular" &&
      !attachmentRestoredFromCache;

    const inserted = await insertSparkbotMessage({
      rep_id: rep.id,
      hub_location_id: hubLocationId,
      agent_id: hubAgent.id,
      active_location_id: tok.location_id,
      role: "user",
      content: persistContent,
      channel: "web_ui",
      metadata: {
        ghl_user_id: tok.ghl_user_id,
        attachment_kind: attachment?.kind || null,
        attachment_filename: !attachment
          ? null
          : attachment.kind === "tabular"
          ? attachment.tabular.filename
          : attachment.kind === "image"
          ? (attachment.filename ?? null)
          : attachment.kind === "document"
          ? attachment.filename
          : null,
        attachment_restored_from_cache: attachmentRestoredFromCache,
        ...(shouldCacheAttachment ? { attachment_full: attachment } : {}),
      },
    });
    userInsertId = inserted?.id || null;
  } catch (err) {
    console.warn("[Sparkbot:send] sparkbot_messages insert crashed:", err instanceof Error ? err.message : err);
    // Sweep F49 2026-06-05: persist falhou → gap no histórico (próximo turno
    // não vê essa msg). Não-bloqueante (resposta segue), mas sinaliza.
    reportError({ title: "SparkBot send: msg do rep não persistida", feature: "sparkbot-messaging", severity: "medium", error: err });
  }

  // 6. Heartbeat + silence reset.
  // - web_session_active_at: rep tá ativo no painel (canal preferido proativo)
  // - last_inbound_at + reset counter: limpa qualquer pausa por silêncio,
  //   já que o rep falou. Espelha lógica do webhook-handler.ts WhatsApp.
  try {
    const nowIso = new Date().toISOString();
    const heartbeatPatch = {
      web_session_active_at: nowIso,
      last_inbound_at: nowIso,
      consecutive_proactive_without_reply: 0,
      proactive_paused_at: null,
      proactive_warned_at: null,
    };
    // web_session_active_at existe no DB mas não no tipo RepIdentity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateRepById(rep.id, heartbeatPatch as any);
  } catch { /* coluna ausente — sem heartbeat */ }

  // 7. Monta RepInput. Se tem attachment, usa ele; message vira caption.
  // Se só tem message, kind=text. Se ambos, attachment ganha (com caption).
  const repInput: RepInput = (() => {
    if (attachment) {
      // Aceita só os 3 kinds vindos do upload (não text/audio)
      if (attachment.kind === "image") {
        return { ...attachment, caption: message || attachment.caption };
      }
      if (attachment.kind === "document") {
        return { ...attachment, caption: message || attachment.caption };
      }
      if (attachment.kind === "tabular") {
        return { ...attachment, caption: message || attachment.caption };
      }
    }
    return { kind: "text", text: message };
  })();

  // 8. Processa via Sparkbot — channel='web_ui' injetado no runtime context
  // pra prompt-builder/tools saberem o contexto.
  const startTs = Date.now();
  const result = await processIncoming({
    rep,
    input: repInput,
    agentId: hubAgent.id,
    conversationHistory,
    channel: "web_ui",
    config: {
      confirmation_mode:
        (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") ||
        "high_only",
      ai_model: agentConfig?.ai_model ?? undefined,
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

  // 8. Persiste resposta (channel='web_ui'); marca como já lida (foi sent
  // diretamente pro browser, não é proativa pendente). Defensivo.
  try {
    await insertSparkbotMessage({
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
  } catch (err) {
    console.warn("[Sparkbot:send] persist agent msg failed:", err instanceof Error ? err.message : err);
    // Sweep F49 2026-06-05: resposta entregue ao browser (JSON) mas não salva
    // no histórico → próximo turno perde contexto. Não-bloqueante.
    reportError({ title: "SparkBot send: resposta do agente não persistida", feature: "sparkbot-messaging", severity: "medium", error: err });
  }

  return json({
    ok: true,
    text: result.text,
    tools_executed: result.tools_executed,
    tokens: result.tokens,
    model_used: result.model_used,
    duration_ms: durationMs,
    user_message_id: userInsertId,
  });
}
