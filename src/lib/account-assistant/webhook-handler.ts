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
import { trackAndCharge } from "@/lib/billing/charge";
import { pickOutboundChannel, fallbackChannel } from "./outbound-channel";
import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";

const SPARKBOT_HISTORY_TURNS = 30;

/**
 * Mutex em memória pra dedup concorrente dentro de uma única lambda.
 * Não substitui a UNIQUE constraint (multi-lambda) mas evita 2× Whisper
 * quando GHL faz dup-burst em <1s (caso raro mas mostrável).
 * TTL: 60s — depois disso a UNIQUE constraint cobre.
 */
const inFlightMessages = new Map<string, number>();
const IN_FLIGHT_TTL_MS = 60_000;
function tryClaimInFlight(ghlMessageId: string): boolean {
  const now = Date.now();
  // GC entries expiradas
  for (const [k, expiresAt] of inFlightMessages) {
    if (expiresAt < now) inFlightMessages.delete(k);
  }
  if (inFlightMessages.has(ghlMessageId)) return false;
  inFlightMessages.set(ghlMessageId, now + IN_FLIGHT_TTL_MS);
  return true;
}
function releaseInFlight(ghlMessageId: string): void {
  inFlightMessages.delete(ghlMessageId);
}

/** Acumulador de telemetria de áudio extraído (pra billing posterior). */
interface AudioMeta {
  audio_seconds: number;
  model: string;
}

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
  const { hubLocationId, contactId, conversationId, messageBody: rawBody, messageType, direction, body } = args;

  if (direction !== "inbound") {
    console.log(`[Sparkbot] skip outbound (type=${messageType})`);
    return;
  }

  // Idempotency (fix audit C3 + concurrent retry):
  // GHL retry de webhook com mesmo messageId não pode reprocessar
  // (2x Whisper bill, 2x LLM, 2x resposta enviada).
  //
  // Tripla defesa:
  //   1. Mutex em memória — bloqueia race concorrente DENTRO da mesma lambda
  //      (ex: GHL dup-burst em <1s). Esse cobre o caso "Whisper duplicate"
  //      que o SELECT-then-process não cobria.
  //   2. SELECT upfront — pega retries sequenciais (cold start em outra lambda).
  //   3. UNIQUE constraint na INSERT do user_msg — última defesa, capturada
  //      via error.code === "23505" (Postgres unique_violation).
  const ghlMessageId = (body.messageId || body.message_id || body.id) as string | undefined;
  if (ghlMessageId) {
    if (!tryClaimInFlight(ghlMessageId)) {
      console.log(`[Sparkbot] dedupe in-flight: ${ghlMessageId} já sendo processado, skipping`);
      return;
    }
    try {
      const supabaseEarly = createAdminClient();
      const { data: existing } = await supabaseEarly
        .from("sparkbot_messages")
        .select("id")
        .eq("ghl_message_id", ghlMessageId)
        .maybeSingle();
      if (existing) {
        console.log(`[Sparkbot] dedupe SELECT: ghl_message_id ${ghlMessageId} já processado, skipping`);
        releaseInFlight(ghlMessageId);
        return;
      }
    } catch (err) {
      console.warn("[Sparkbot] idempotency lookup falhou — segue (UNIQUE constraint pega):", err instanceof Error ? err.message : err);
    }
  }
  // Garantia: liberar in-flight ao sair da função, qualquer caminho.
  // try/finally wrapping abaixo cobre exceções E early returns.
  const cleanupInFlight = () => { if (ghlMessageId) releaseInFlight(ghlMessageId); };
  try {

  // REACTION detection (fix audit Reaction emoji loops):
  // GHL/Stevo enviam reactions com messageType=REACTION e body=emoji puro.
  // 👍 ✅ 👌 etc → "sim" pra LLM tratar como confirmação.
  // 👎 ❌ → "não" (rep abortando uma confirmação pendente).
  // Outros emojis → ignora (return). Senão LLM gera greeting estranho.
  // Case-insensitive por defesa (GHL às vezes manda "REACTION" outras "Reaction").
  let messageBody = rawBody;
  const mtUpper = (messageType || "").toUpperCase();
  if (mtUpper === "REACTION" || mtUpper === "TYPE_REACTION") {
    // Body pode vir como literal emoji ou JSON-wrapped (Stevo varia).
    // Tenta extrair emoji se for JSON; senão trim direto.
    let emoji = (rawBody || "").trim();
    try {
      const maybeJson = JSON.parse(rawBody);
      if (typeof maybeJson === "object" && maybeJson) {
        const candidate = (maybeJson as Record<string, unknown>).reaction
          || (maybeJson as Record<string, unknown>).emoji
          || (maybeJson as Record<string, unknown>).text;
        if (typeof candidate === "string") emoji = candidate.trim();
      }
    } catch { /* não é JSON, segue com rawBody */ }

    // Strip variation selectors (U+FE00..FE0F) e skin tone modifiers
    // (U+1F3FB..1F3FF) pra matchear ✔️ vs ✔ e 👍🏼 vs 👍.
    const norm = emoji.replace(/[\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "");

    const positiveReactions = ["👍", "✅", "👌", "🆗", "✔", "✓", "💯", "🙏", "👏", "❤"];
    const negativeReactions = ["👎", "❌", "🚫"];

    if (positiveReactions.some((p) => norm.includes(p))) {
      messageBody = "sim";
      console.log(`[Sparkbot] REACTION ${emoji} mapeado pra "sim" (confirmação positiva)`);
    } else if (negativeReactions.some((n) => norm.includes(n))) {
      messageBody = "não, cancela";
      console.log(`[Sparkbot] REACTION ${emoji} mapeado pra "não" (cancela ação pendente)`);
    } else {
      console.log(`[Sparkbot] REACTION ${emoji} ignorada (não é positiva nem negativa)`);
      return;
    }
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

  // 3. Extrai input multimodal — captura audio_seconds em audioSink pra
  //    cobrança Whisper posterior (depois de hubAgent ser conhecido).
  const audioSink: { current: AudioMeta | null } = { current: null };
  let repInput = await extractRepInput({ body, messageBody, audioMetaSink: audioSink });

  // PLACEHOLDER REJECTION (fix bug 2026-05-03):
  // Quando GHL multi-provider envia áudio/mídia, um dos providers
  // costuma mandar webhook só com placeholder text ("Audio Message.",
  // "Image", "Document", etc.) e SEM audio_url/media_url processável.
  // O outro provider manda o conteúdo real.
  //
  // Se aceitarmos o placeholder, o bot responde "Não consigo processar
  // áudio" enquanto o webhook bom é bloqueado pelo timing-match.
  //
  // Fix: detecta placeholder genérico e abortar. O webhook irmão (com
  // conteúdo real) chegou ou vai chegar em <5s — esse processa.
  const PLACEHOLDER_TEXTS = new Set([
    "Audio Message.",
    "Audio message",
    "audio message",
    "Image",
    "image",
    "Image message",
    "Document",
    "document",
    "Video",
    "video",
    "Sticker",
    "sticker",
  ]);
  const isPlaceholderText = repInput.kind === "text" && PLACEHOLDER_TEXTS.has(repInput.text.trim());

  // FIX: o webhook do Stevo VEM com body="Audio Message." E COM
  // attachments=[audio_url] válida. Se rejeitarmos só por placeholder,
  // perdemos a URL processável. Solução: só rejeita se NÃO tem attachment.
  const audioUrlInfo = (await import("@/lib/ai/audio-transcriber"))
    .extractAudioUrl(body);
  const mediaAttachmentsForCheck = (await import("@/lib/ai/media-extractor"))
    .extractMediaAttachments(body);
  const hasUsableAttachment = !!audioUrlInfo?.url || mediaAttachmentsForCheck.length > 0;

  // PLACEHOLDER REJECT: só se for texto placeholder E sem mídia processável.
  // Se tem attachment, o webhook é "bom" (apenas o body é placeholder do GHL).
  if (isPlaceholderText && repInput.kind === "text" && !hasUsableAttachment) {
    console.warn(
      `[Sparkbot] PLACEHOLDER REJECT: msg "${repInput.text}" do rep (contact=${contactId}) — ` +
      `sem attachment, provider sem audio_url/media. Aguardando webhook irmão.`,
    );
    return;
  }

  // RE-PROCESSA REPINPUT se tem attachment mas extração inicial não pegou.
  // Caso típico: body="Audio Message." mas attachments=[audio.ogg].
  // Se temos audio_url, força transcribe explicit usando verbose
  // (que retorna erro estruturado em vez de null silencioso).
  let transcribeFailureCode: string | null = null;
  if (audioUrlInfo?.url && repInput.kind === "text") {
    console.log(`[Sparkbot] re-processando como áudio (URL detected: ${audioUrlInfo.url.slice(0, 80)})`);
    const { transcribeAudioFromUrlVerbose } = await import("@/lib/ai/audio-transcriber");
    const verboseResult = await transcribeAudioFromUrlVerbose(audioUrlInfo.url, audioUrlInfo.mimeType);
    if (verboseResult.ok) {
      const transcribed = verboseResult.result;
      repInput = {
        kind: "audio",
        transcribed_text: transcribed.text,
        original_url: audioUrlInfo.url,
      };
      if (transcribed.audio_seconds > 0) {
        audioSink.current = {
          audio_seconds: transcribed.audio_seconds,
          model: transcribed.model,
        };
      }
    } else {
      transcribeFailureCode = verboseResult.code;
      console.error(
        `[Sparkbot] transcribe falhou: code=${verboseResult.code} msg=${verboseResult.message}`,
      );
    }
  }

  // Mensagem específica ao rep quando transcribe falha por motivo conhecido.
  // Encurta o ciclo de debug — em vez de bot dizer "Não consigo processar
  // áudio", admin sabe na hora se é problema de billing, key, etc.
  if (transcribeFailureCode === "quota_exceeded") {
    await sendResponseToRep(
      hubClient, contactId, conversationId, messageType,
      "⚠️ A OpenAI tá com a quota esgotada — admin precisa recarregar créditos. Manda em texto enquanto isso.",
    );
    return;
  }
  if (transcribeFailureCode === "invalid_key") {
    await sendResponseToRep(
      hubClient, contactId, conversationId, messageType,
      "⚠️ A API key da OpenAI tá inválida — admin precisa atualizar. Manda em texto enquanto isso.",
    );
    return;
  }
  if (transcribeFailureCode === "rate_limited") {
    await sendResponseToRep(
      hubClient, contactId, conversationId, messageType,
      "Tô com lentidão pra processar áudio agora. Tenta de novo em 1min ou manda em texto.",
    );
    return;
  }

  // 4. Busca agent Sparkbot na Hub (pra billing + config)
  const supabase = createAdminClient();

  // Dedup CONTENT-MATCH (fix bug observado em prod 2026-05-03):
  // Quando o GHL tem WhatsApp Business API + Stevo (Evolution) conectados
  // ao mesmo tempo, cada msg física do rep cria DOIS webhooks com
  // ghl_message_id DIFERENTES (cada provider gera seu próprio ID). A
  // idempotência por ghl_message_id não pega — passa nos 2.
  //
  // Defesa: se já tem mensagem do MESMO rep com MESMO conteúdo nos
  // últimos 15s, é dup física. Skip.
  // Janela conservadora pra não bloquear rep que digita "oi" 2x rápido
  // legitimamente.
  if (repInput.kind === "text" && messageBody.trim().length > 0) {
    try {
      const cutoffDup = new Date(Date.now() - 15 * 1000).toISOString();
      const { data: recentDup } = await supabase
        .from("sparkbot_messages")
        .select("id, ghl_message_id")
        .eq("rep_id", rep.id)
        .eq("hub_location_id", hubLocationId)
        .eq("role", "user")
        .eq("content", messageBody)
        .gte("created_at", cutoffDup)
        .limit(1)
        .maybeSingle();
      if (recentDup) {
        console.warn(
          `[Sparkbot] dedupe CONTENT-MATCH: msg "${messageBody.slice(0, 30)}" do rep ${rep.id} ` +
          `já processada nos últimos 15s (orig ghl_msg=${recentDup.ghl_message_id}, ` +
          `current=${ghlMessageId}). Provável GHL multi-provider routing (WhatsApp API + Stevo).`,
        );
        return;
      }
    } catch (err) {
      console.warn("[Sparkbot] content-match dedup falhou:", err instanceof Error ? err.message : err);
    }
  }

  // Dedup TIMING-MATCH (fix bug observado em prod 2026-05-03 com áudio):
  // Pra áudio/imagem/PDF, os 2 webhooks do GHL multi-provider podem trazer
  // CONTEÚDOS DIFERENTES (um transcreve com sucesso, outro vem só com
  // placeholder "Audio Message."). Content-match não pega.
  //
  // Fix: janela curta de 5s — se rep teve QUALQUER user msg nos últimos 5s,
  // este webhook é o segundo do par. Skip.
  //
  // Trade-off: rep humano mandando 2 msgs em <5s vai ter a 2ª bloqueada.
  // Rare em prática (humanos digitam >2s entre msgs); GHL multi-provider
  // dispara em <500ms tipicamente. Logamos pra o Pedro saber se afeta.
  try {
    const cutoffTiming = new Date(Date.now() - 5 * 1000).toISOString();
    const { data: recentAny } = await supabase
      .from("sparkbot_messages")
      .select("id, ghl_message_id, content, created_at")
      .eq("rep_id", rep.id)
      .eq("hub_location_id", hubLocationId)
      .eq("role", "user")
      .gte("created_at", cutoffTiming)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentAny) {
      const ageMs = Date.now() - new Date(recentAny.created_at as unknown as string).getTime();
      console.warn(
        `[Sparkbot] dedupe TIMING-MATCH: rep ${rep.id} já tem user msg de ${ageMs}ms atrás ` +
        `(orig content="${(recentAny.content || "").slice(0, 30)}", ghl_msg=${recentAny.ghl_message_id}; ` +
        `current=${ghlMessageId}). GHL multi-provider routing — 2º webhook bloqueado.`,
      );
      return;
    }
  } catch (err) {
    console.warn("[Sparkbot] timing-match dedup falhou:", err instanceof Error ? err.message : err);
  }

  // Sticky tabular cache (fix audit C1): se este turn é só texto OU áudio
  // e o rep mandou um CSV/XLSX nas últimas 30 min, restaura o anexo.
  // Senão LLM perde contexto e pede "reanexa o CSV" — bug visto no Web UI
  // antes do fix em send/route.ts; aqui replicamos pra paridade WhatsApp.
  // Audio incluído porque rep no WhatsApp costuma confirmar via voz
  // ("sim, importa") e quebrar o cache nesse caso é UX ruim (NB-6 do agent
  // de validação 2026-05-02).
  let restoredFromCache = false;
  const repTextForRestore =
    repInput.kind === "text"
      ? repInput.text
      : repInput.kind === "audio"
      ? repInput.transcribed_text
      : "";
  if (repInput.kind === "text" || repInput.kind === "audio") {
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: cachedRows } = await supabase
        .from("sparkbot_messages")
        .select("metadata, created_at")
        .eq("rep_id", rep.id)
        .eq("hub_location_id", hubLocationId)
        .eq("role", "user")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(10);
      const cachedRow = (cachedRows || []).find((m) => {
        const meta = m.metadata as { attachment_full?: { kind?: string; tabular?: { rows?: unknown[]; filename?: string } } } | null;
        // Validação completa: kind=tabular E rows é array E filename existe.
        // Antes era só `kind === "tabular"` — corrupção em metadata.attachment_full
        // crashava no acesso a .tabular.filename downstream.
        return (
          meta?.attachment_full?.kind === "tabular" &&
          Array.isArray(meta.attachment_full.tabular?.rows) &&
          typeof meta.attachment_full.tabular?.filename === "string"
        );
      });
      if (cachedRow) {
        const meta = cachedRow.metadata as { attachment_full?: RepInput };
        if (meta.attachment_full && meta.attachment_full.kind === "tabular") {
          // Preserva o texto do rep como caption pro contexto da turn
          repInput = { ...meta.attachment_full, caption: repTextForRestore };
          restoredFromCache = true;
          console.log(`[Sparkbot] anexo tabular restaurado do cache (rep=${rep.id}, idade=${Math.round((Date.now() - new Date(cachedRow.created_at as unknown as string).getTime()) / 1000)}s)`);
        }
      }
    } catch (err) {
      console.warn("[Sparkbot] sticky cache lookup falhou:", err instanceof Error ? err.message : err);
    }
  }
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

  // C4 fix: cobra Whisper se o webhook recebeu áudio. Antes, transcribe
  // rodava mas NUNCA cobrava — Sparkbot WhatsApp Whisper 100% free.
  if (audioSink.current && audioSink.current.audio_seconds > 0) {
    try {
      // BYO key check — se hub location tem própria OPENAI_API_KEY, skipa
      const { data: ls } = await supabase
        .from("location_settings")
        .select("openai_api_key")
        .eq("location_id", hubLocationId)
        .maybeSingle();
      const usesCustomKey = !!ls?.openai_api_key;

      await trackAndCharge({
        locationId: hubLocationId,
        companyId: hubCompanyId,
        agentId: hubAgent.id,
        contactId: rep.id,
        actionType: "audio_transcription",
        model: audioSink.current.model,
        audioSeconds: audioSink.current.audio_seconds,
        audioModel: audioSink.current.model,
        usesCustomKey,
      });
    } catch (e) {
      console.warn(
        "[Sparkbot] Whisper billing falhou (não-bloqueante):",
        e instanceof Error ? e.message : e,
      );
    }
  }

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
  // Quando restoredFromCache: NÃO repete o ícone tabular no histórico —
  // o conteúdo é só o texto do rep (ex: "sim"), pra histórico não virar
  // "📊 file.csv" em toda turn dentro de 30min.
  const userMsgContent = (() => {
    if (restoredFromCache) {
      return repTextForRestore || "(sem texto)";
    }
    if (repInput.kind === "text") return repInput.text;
    if (repInput.kind === "audio") return `🎤 "${repInput.transcribed_text}"`;
    if (repInput.kind === "image") return repInput.caption || "[imagem]";
    if (repInput.kind === "document") {
      return `📎 ${repInput.filename}${repInput.extracted_text ? `\n${repInput.extracted_text.substring(0, 500)}` : ""}`;
    }
    if (repInput.kind === "tabular") {
      return `📊 ${repInput.tabular.filename} (${repInput.tabular.total_rows} linhas)${repInput.caption ? `\n${repInput.caption}` : ""}`;
    }
    return "(input)";
  })();

  // Defensivo: tabela pode não existir; não queremos quebrar webhook.
  // Cache da tabular pra sticky attachment (TTL 30min, mesma lógica do
  // send/route.ts). Só salva se for tabular nesta turn original (NÃO
  // restaurada do cache — senão duplicaria a metadata em cascata).
  const shouldCacheTabular = repInput.kind === "tabular" && !restoredFromCache;
  // Supabase JS NÃO faz throw em insert errors — devolve { error }.
  // O try/catch antigo era dead code; agora capturamos o `error.code`
  // explicitamente. 23505 = unique_violation (Postgres).
  const insertResult = await supabase.from("sparkbot_messages").insert({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: hubAgent.id,
    active_location_id: rep.active_location_id || null,
    role: "user",
    content: userMsgContent,
    channel: "whatsapp",
    ghl_message_id: ghlMessageId || null,
    metadata: {
      input_kind: repInput.kind,
      ghl_contact_id: contactId,
      ...(restoredFromCache ? { attachment_restored_from_cache: true } : {}),
      ...(shouldCacheTabular ? { attachment_full: repInput } : {}),
    },
  });
  if (insertResult.error) {
    // Idempotency: UNIQUE violation on ghl_message_id é dedup signal
    if (insertResult.error.code === "23505") {
      console.log(`[Sparkbot] dedupe via UNIQUE constraint: ghl_message_id ${ghlMessageId} já inserido — skipping`);
      cleanupInFlight();
      return;
    }
    console.warn("[Sparkbot] sparkbot_messages insert (user) failed:", insertResult.error.message);
  }

  // Silence reset (fix audit Phase 3): qualquer inbound do rep limpa
  // o counter e a pausa. Se o rep tava silenciado, agora reabriu a janela
  // (no sentido WhatsApp 24h tbm).
  try {
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
    console.warn("[Sparkbot] silence reset falhou (não-bloqueante):", err instanceof Error ? err.message : err);
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

  } finally {
    // Cleanup do in-flight mutex, qualquer caminho de saída
    cleanupInFlight();
  }
}

/**
 * Extrai RepInput do webhook body (áudio → whisper, imagem → base64, doc → extract).
 *
 * C4 fix: caller pode passar `audioMetaSink` pra capturar audio_seconds e
 * cobrar Whisper depois. Antes deste fix, extractRepInput transcrevia áudio
 * mas NUNCA cobrava — Sparkbot WhatsApp rodava Whisper free.
 */
async function extractRepInput(args: {
  body: Record<string, unknown>;
  messageBody: string;
  audioMetaSink?: { current: AudioMeta | null };
}): Promise<RepInput> {
  const { body, messageBody, audioMetaSink } = args;

  const audioInfo = extractAudioUrl(body);
  if (audioInfo?.url) {
    try {
      const transcribed = await transcribeAudioFromUrl(audioInfo.url);
      if (transcribed?.text) {
        if (audioMetaSink && transcribed.audio_seconds > 0) {
          audioMetaSink.current = {
            audio_seconds: transcribed.audio_seconds,
            model: transcribed.model,
          };
        }
        return { kind: "audio", transcribed_text: transcribed.text, original_url: audioInfo.url };
      }
    } catch (err) {
      console.warn("[Sparkbot] audio transcription failed:", err instanceof Error ? err.message : err);
    }
  }

  const attachments = extractMediaAttachments(body);
  if (attachments.length > 0) {
    // Pega o PRIMEIRO anexo suportado e processa via file-processor unificado
    // (mesmo parser que o painel web usa). Imagem/PDF/CSV/XLSX viram RepInput
    // do tipo apropriado.
    for (const att of attachments) {
      try {
        const res = await fetch(att.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
          console.warn(`[Sparkbot] failed to fetch attachment ${att.url}: ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const { processFile } = await import("./file-processor");
        const result = await processFile({
          buffer,
          mime: att.contentType,
          filename: att.fileName || "arquivo",
        });

        // Anexa caption do messageBody (rep pode mandar texto + arquivo)
        const repInput = result.repInput;
        if (repInput.kind === "image") {
          return { ...repInput, caption: messageBody || undefined };
        }
        if (repInput.kind === "document") {
          return { ...repInput, caption: messageBody || undefined };
        }
        if (repInput.kind === "tabular") {
          return { ...repInput, caption: messageBody || undefined };
        }
      } catch (err) {
        console.warn(
          "[Sparkbot] file processing failed for", att.url, ":",
          err instanceof Error ? err.message : err,
        );
        // Tenta próximo anexo
      }
    }
  }

  return { kind: "text", text: messageBody };
}

/**
 * Envia resposta pro rep via GHL.
 *
 * Default agora é SMS (Stevo/Evolution roteia pro WhatsApp do rep) porque
 * a WhatsApp Business API ainda tá em review. Quando liberada, basta setar
 * ASSISTANT_OUTBOUND_CHANNEL=auto e implementar checkConversationWindow.
 *
 * Mantém fallback pra outro canal em caso de falha (ex: SMS provider down →
 * tenta WhatsApp; ou WhatsApp 24h-window fechada → tenta SMS).
 */
async function sendResponseToRep(
  client: GHLClient,
  contactId: string,
  conversationId: string,
  incomingType: string,
  text: string,
): Promise<void> {
  const tryType = pickOutboundChannel(incomingType);
  const payload: Record<string, unknown> = {
    type: tryType,
    contactId,
    message: text,
  };
  if (conversationId) payload.conversationId = conversationId;

  try {
    await client.post("/conversations/messages", payload);
  } catch (err) {
    const fb = fallbackChannel(tryType);
    console.warn(
      `[Sparkbot] send failed on ${tryType} — trying fallback ${fb}:`,
      err instanceof Error ? err.message : err,
    );
    try {
      await client.post("/conversations/messages", {
        type: fb,
        contactId,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
    } catch (err2) {
      console.error("[Sparkbot] send fallback also failed:", err2 instanceof Error ? err2.message : err2);
    }
  }
}
