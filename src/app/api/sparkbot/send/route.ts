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
import type { RepInput } from "@/types/account-assistant";

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
  let priorMsgs: Array<{ role: string; content: string; created_at: string }> = [];
  try {
    const r = await supabase
      .from("sparkbot_messages")
      .select("role, content, created_at")
      .eq("rep_id", rep.id)
      .eq("hub_location_id", hubLocationId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (r.data) priorMsgs = r.data;
    if (r.error) {
      // Migration 00040 ainda não aplicada — segue sem histórico.
      console.warn("[Sparkbot:send] sparkbot_messages read err:", r.error.message);
    }
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

    const r = await supabase
      .from("sparkbot_messages")
      .insert({
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
      })
      .select("id")
      .single();
    userInsertId = r.data?.id || null;
    if (r.error) {
      console.warn("[Sparkbot:send] sparkbot_messages insert err:", r.error.message);
    }
  } catch (err) {
    console.warn("[Sparkbot:send] sparkbot_messages insert crashed:", err instanceof Error ? err.message : err);
  }

  // 6. Heartbeat: marca que rep tá ativo no web (pra canal automático
  // decidir mandar proativos no web vs WhatsApp). Defensivo — coluna pode
  // não existir se migration 00042 ainda pendente.
  try {
    await supabase
      .from("rep_identities")
      .update({ web_session_active_at: new Date().toISOString() })
      .eq("id", rep.id);
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
        "medium_and_high",
      ai_model: agentConfig?.ai_model,
    },
  });
  const durationMs = Date.now() - startTs;

  // 8. Persiste resposta (channel='web_ui'); marca como já lida (foi sent
  // diretamente pro browser, não é proativa pendente). Defensivo.
  try {
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
  } catch (err) {
    console.warn("[Sparkbot:send] persist agent msg failed:", err instanceof Error ? err.message : err);
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
