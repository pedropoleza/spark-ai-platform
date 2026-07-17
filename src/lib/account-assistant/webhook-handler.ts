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
import { trackAndCharge } from "@/lib/billing/charge";
import { reportError } from "@/lib/admin-signals/report-error";
import { extractRepInput, type AudioMeta } from "./webhook/input-parser";
import { sendResponseToRep } from "./webhook/sparkbot-send";
import {
  tryClaimInFlight,
  releaseInFlight,
  tryContentDedupLock,
} from "./webhook/dedup-guard";
import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";

const SPARKBOT_HISTORY_TURNS = 30;

// ─────────────────────────────────────────────────────────────────────────
// Decomposição V2.2 (ver _planning/_review-2026-05-19/B1-arquitetura.md §4):
// este handler era um god-file de 1.052 LOC. Extraídos pra ./webhook/*:
//   • input-parser.ts   → extractRepInput (+ tipo AudioMeta) — parsing puro.
//   • sparkbot-send.ts   → sendResponseToRep + split de mensagens.
//   • dedup-guard.ts     → mutex em memória (camada 1, BYTE-A-BYTE) +
//                          camada 8 ADITIVA (content-hash lock, janela 2s).
//
// O que NÃO foi movido: as camadas 2–7 de idempotência (SELECTs CONTENT/
// TIMING-MATCH, INSERT minute-bucket em sparkbot_dedup_locks, captura 23505)
// continuam INLINE abaixo porque estão interleavadas com o fluxo (rep,
// supabase, early-returns no meio do pipeline) — movê-las mudaria control-flow
// e arriscaria a ingestão. O handler segue orquestrador, comportamento idêntico.
// ─────────────────────────────────────────────────────────────────────────

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

  // H33 Pedro 2026-05-18: pause follow-up sequences IMEDIATAMENTE se o
  // contato respondeu. Faster do que esperar followup-runner descobrir no
  // próximo tick.
  // Async/silent — não bloqueia processamento do inbound se falhar.
  if (contactId) {
    (async () => {
      try {
        const { onContactInboundReceived } = await import("./followup/sequence-monitor");
        const r = await onContactInboundReceived(contactId, hubLocationId);
        if (r.paused_sequences > 0) {
          console.log(
            `[Sparkbot] followup: pausou ${r.paused_sequences} sequence(s) por reply do contato ${contactId}`,
          );
        }
      } catch (err) {
        console.warn(
          "[Sparkbot] followup pause-on-reply falhou:",
          err instanceof Error ? err.message.slice(0, 150) : err,
        );
      }
    })();

    // Etapa 4.4 (Pedro 2026-05-28): pause-on-reply pra bulk_message_sequence_state
    // (campanhas multi-toque do /hub/campaigns). Schema/regras diferentes do
    // followup, daí monitor separado. Mesma estratégia async/silent.
    (async () => {
      try {
        const { pauseBulkSequencesOnReply } = await import("./proactive/bulk-sequence-monitor");
        const r = await pauseBulkSequencesOnReply(contactId, hubLocationId);
        if (r.paused_states > 0) {
          console.log(
            `[Sparkbot] bulk-seq: pausou ${r.paused_states} state(s) + cancelou ${r.cancelled_recipients} pending pra contato ${contactId}`,
          );
        }
      } catch (err) {
        console.warn(
          "[Sparkbot] bulk-seq pause-on-reply falhou:",
          err instanceof Error ? err.message.slice(0, 150) : err,
        );
      }
    })();

    // Etapa 4.7 final (Pedro 2026-05-28): variant reply tracker. Marca
    // replied_at no recipient enviado mais recente (últimos 7d) → UI A/B
    // mostra reply rate por variante. Não bloqueia inbound se DB cair.
    (async () => {
      try {
        const { trackVariantReply } = await import("./proactive/variant-reply-tracker");
        const r = await trackVariantReply(contactId, hubLocationId);
        if (r.matched && r.variant_id) {
          console.log(
            `[Sparkbot] variant-reply: job=${r.job_id?.slice(0, 8)} variant=${r.variant_id} step=${r.sequence_step ?? "n/a"}`,
          );
        }
      } catch (err) {
        console.warn(
          "[Sparkbot] variant-reply tracker falhou:",
          err instanceof Error ? err.message.slice(0, 150) : err,
        );
      }
    })();

    // Etapa 4.8 (Pedro 2026-05-28): detector de opt-out (STOP/PARAR/etc).
    // Match estrito por palavra inteira. Insere em outreach_optouts. Runner
    // do bulk-message-runner depois pula recipients com opt-out ativo.
    if (rawBody && rawBody.trim().length > 0 && rawBody.length < 200) {
      (async () => {
        try {
          const { processInboundForOptOut } = await import("./proactive/optout-detector");
          const r = await processInboundForOptOut(hubLocationId, contactId, rawBody);
          if (r.detected) {
            console.log(
              `[Sparkbot] opt-out detectado: keyword='${r.matched_keyword}' source=${r.source} contato=${contactId} recorded=${r.recorded}`,
            );
          }
        } catch (err) {
          console.warn(
            "[Sparkbot] opt-out detector falhou:",
            err instanceof Error ? err.message.slice(0, 150) : err,
          );
        }
      })();
    }
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

  // REACTION detection (fix audit Reaction emoji loops + recency check):
  // GHL/Stevo enviam reactions com messageType=REACTION e body=emoji puro.
  // 👍 ✅ 👌 etc → "sim" pra LLM tratar como confirmação.
  // 👎 ❌ → "não" (rep abortando uma confirmação pendente).
  // Outros emojis → ignora (return). Senão LLM gera greeting estranho.
  //
  // Fix CRITICAL stress test 2026-05-03: REACTION pode ser a uma msg ANTIGA
  // (rep volta dias depois e reage 👍 a uma confirmação que perdeu o
  // contexto). Antes, mapeávamos pra "sim" cego e LLM tentava executar a
  // tool atual com base em histórico errado. Agora exigimos que a última
  // msg do bot seja recente (< 10min) — senão ignora a reação.
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

    // FIX CRITICAL stress test 2026-05-03: recency check.
    // Reaction antiga (rep volta dias depois e reage 👍 a uma msg perdida)
    // não deve mapear pra "sim" — LLM tentaria executar tool com base em
    // histórico errado. Exige última msg agent do mesmo contact < 10min.
    try {
      const supabaseRecency = createAdminClient();
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: lastBot } = await supabaseRecency
        .from("sparkbot_messages")
        .select("id, created_at")
        .eq("hub_location_id", hubLocationId)
        .eq("role", "agent")
        .filter("metadata->>ghl_contact_id", "eq", contactId)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!lastBot) {
        console.warn(
          `[Sparkbot] REACTION ${emoji} ignorada — sem msg do bot nos últimos 10min ` +
          `pra contact ${contactId}. Provável reação a msg antiga.`,
        );
        return;
      }
    } catch (err) {
      console.warn("[Sparkbot] REACTION recency check falhou (segue):", err instanceof Error ? err.message : err);
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
    // Sweep F49 2026-06-05: sem contato → sem phone → rep não recebe resposta.
    reportError({ title: "SparkBot webhook: falha ao buscar contato do hub", feature: "sparkbot-webhook", severity: "high", error: err });
    return;
  }

  if (!phone) {
    console.log(`[Sparkbot] no phone for hub contact ${contactId}, ignoring`);
    return;
  }

  // 2. Identifica rep (busca ou cria)
  const rep = await identifyRep(phone);
  if (rep === "scan_failed") {
    // Sweep 2026-06-17: a varredura quebrou em 100% das locations (token GHL
    // caído) — NÃO dizer "não cadastrado" (mentira que esconde apagão). O
    // reportError crítico já foi disparado dentro do identifyRep. Pede retry.
    await sendResponseToRep(
      hubClient, contactId, conversationId, messageType,
      "Tô com um probleminha técnico pra te identificar agora 😕 Manda sua mensagem de novo daqui a 1 minutinho?",
    );
    return;
  }
  if (!rep) {
    // Rep não encontrado em location nenhuma (varredura OK). Causa comum: rep
    // mandou de um número DIFERENTE do cadastrado no GHL user (caso Jussara
    // 2026-06-19 — tinha 321, escreveu do 689) → bot mudo e ninguém percebe.
    //
    // Fix recorrência 2026-06-19: o título inclui o PHONE de propósito (quebra a
    // regra "title estável" do reportError DE PROPÓSITO neste caso) → cada número
    // não-cadastrado vira uma linha DISTINTA e ACIONÁVEL no /hub/admin/health, em
    // vez de todos colapsarem num único LOW sem telefone (o que escondia o caso).
    // severity 'medium' pra ficar visível no painel (não empurra push — número
    // errado/spam não deve acordar ninguém). Admin vê o phone → corrige o GHL
    // user (ou cria a rep) na hora. Volume baixo (número desconhecido é raro).
    reportError({
      title: `SparkBot: número não cadastrado — ${phone}`,
      feature: "sparkbot-webhook",
      severity: "medium",
      description:
        `Rep mandou do número ${phone} mas identifyRep não achou esse phone em nenhum GHL user ` +
        `(contato GHL: ${contactId}). Provável rep com número divergente: confira o GHL user dela e ` +
        `atualize o phone pra este, ou crie/autorize a rep. Enquanto isso o bot respondeu "não cadastrado".`,
      metadata: { contact_id: contactId, phone },
    });
    await sendResponseToRep(
      hubClient, contactId, conversationId, messageType,
      "Olá! Seu número não está cadastrado em nenhuma location. Fale com o admin da sua agência pra ser autorizado.",
    );
    return;
  }

  // CONTENT DEDUP LOCK (fix race 22ms 2026-05-03):
  // Quando 2 webhooks multi-provider chegam em <100ms, ambos fazem o
  // SELECT antes do INSERT — content-match falha. Solução: tabela
  // sparkbot_dedup_locks com UNIQUE PK. Quem entrar primeiro cria o
  // lock; o segundo recebe 23505 e aborta. TTL 60s (auto-expira).
  //
  // Key: rep_id + content + minute_bucket (mesmo minuto = mesma janela).
  // Pra audio/imagem, usa kind+messageType pra reduzir falso-match.
  if (messageBody && messageBody.length > 0) {
    const minuteBucket = Math.floor(Date.now() / 60000); // minuto atual UNIX
    const dedupKey = `${rep.id}|${minuteBucket}|${messageBody.slice(0, 200)}`;
    const supabaseDedup = createAdminClient();
    const lockRes = await supabaseDedup
      .from("sparkbot_dedup_locks")
      .insert({
        dedup_key: dedupKey,
        rep_id: rep.id,
        content_preview: messageBody.slice(0, 100),
      })
      .select("dedup_key")
      .maybeSingle();
    if (lockRes.error) {
      // 23505 = unique_violation — outro webhook ganhou o lock
      if (lockRes.error.code === "23505") {
        console.warn(
          `[Sparkbot] CONTENT DEDUP LOCK: rep ${rep.id} msg "${messageBody.slice(0, 30)}" ` +
          `já claim'd em <60s (${ghlMessageId}). Skipping.`,
        );
        return;
      }
      // Outro erro — não bloqueia (defensivo)
      console.warn("[Sparkbot] dedup lock insert falhou (não-bloqueante):", lockRes.error.message);
    }
  }

  // CAMADA 8 — CONTENT-HASH LOCK, janela CURTA ~2s (ADITIVA, V2.2).
  // Ver _planning/_review-2026-05-19/B2-tools-loop.md §3 P0 #2.
  //
  // Defesa pra dupla-resposta quando a WhatsApp Business API voltar (2
  // providers → 2 webhooks <3ms com ghl_message_id DISTINTOS). A camada 4
  // (minute-bucket acima) já dá uma rede multi-provider, mas seu key inclui o
  // bucket de MINUTO — logo bloqueia até repeats legítimos a 50s de distância
  // dentro do mesmo minuto. Esta camada é complementar e CIRÚRGICA: janela de
  // 2s, com re-check de `created_at` no 23505 pra NUNCA descartar um repeat
  // legítimo (rep que manda "sim" 2× de propósito vem segundos depois → key
  // colide mas o lock está stale → NÃO aborta). 100% aditiva: não substitui
  // nenhuma das 7 camadas; se o DB falhar, segue (isDuplicate=false).
  //
  // Hoje (Stevo-only) raramente dispara — é blindagem pra quando a API voltar.
  if (messageBody && messageBody.length > 0) {
    const contentLock = await tryContentDedupLock({
      repId: rep.id,
      content: messageBody,
      ghlMessageId,
    });
    if (contentLock.isDuplicate) {
      // Webhook concorrente do MESMO evento físico já está sendo processado.
      // Aborta pra não gerar 2ª resposta LLM. (mutex in-flight é liberado no
      // finally via cleanupInFlight.)
      return;
    }
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
    // Fix HIGH stress test 2026-05-03: passar BYO key da location se existe.
    // Antes Pedro pagava Whisper de todas locations mesmo com `usesCustomKey=true`.
    let byoKey: string | undefined;
    try {
      const supabaseByo = createAdminClient();
      const { data: ls } = await supabaseByo
        .from("location_settings")
        .select("openai_api_key")
        .eq("location_id", hubLocationId)
        .maybeSingle();
      byoKey = ls?.openai_api_key || undefined;
    } catch { /* ignora — usa env */ }
    const { transcribeAudioFromUrlVerbose } = await import("@/lib/ai/audio-transcriber");
    const verboseResult = await transcribeAudioFromUrlVerbose(audioUrlInfo.url, audioUrlInfo.mimeType, byoKey);
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
        // Compara com .trim(): o persist path (linha ~747) grava
        // repInput.text.trim(), então msg com espaço nas pontas (comum em
        // copy-paste de WhatsApp) é guardada trimada — buscar o raw nunca
        // casaria. Camadas 3 e 8 (raw-vs-raw) já pegam o dup real antes;
        // isto só alinha esta query ao que de fato está no banco.
        .eq("content", messageBody.trim())
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
  // Fetch separadas (agent + config) — supabase-js type inference quebra com
  // strings longas em select com relação aninhada.
  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id")
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

  const { data: agentConfig } = await supabase
    .from("agent_configs")
    .select("*")
    .eq("agent_id", hubAgent.id)
    .maybeSingle();

  // Whitelist enforcement (admin-configurável 2026-05-03):
  // Se admin populou allowed_ghl_users, só esses ghl_user_ids podem usar.
  // Lista vazia = sem whitelist (default — todos os reps com terms aceitos
  // podem usar). Rejeita explicitamente em vez de silenciar pra rep saber.
  const whitelist: Array<{ ghl_user_id?: string; phone?: string }> = Array.isArray(
    agentConfig?.allowed_ghl_users,
  )
    ? agentConfig.allowed_ghl_users
    : [];
  if (whitelist.length > 0) {
    const allowedIds = new Set(whitelist.map((w) => w.ghl_user_id).filter(Boolean));
    const repHasAllowedUser = rep.ghl_users.some((u) => allowedIds.has(u.ghl_user_id));
    if (!repHasAllowedUser) {
      console.log(
        `[Sparkbot] rep ${rep.id} (phone=${rep.phone}) não está na whitelist da hub ${hubLocationId} — rejeitado.`,
      );
      await sendResponseToRep(
        hubClient, contactId, conversationId, messageType,
        "Você não tá autorizado a usar o Sparkbot nesta agência. Fala com o admin pra ser adicionado à whitelist.",
      );
      return;
    }
  }

  // C4 fix: cobra Whisper se o webhook recebeu áudio. Antes, transcribe
  // rodava mas NUNCA cobrava — Sparkbot WhatsApp Whisper 100% free.
  // Note: webhook flow não tem testSessionId (test sessions usam
  // /api/agents/account-assistant/test/route.ts em vez deste handler).
  // Então sempre cobra. Se algum dia testSessionId for adicionado aqui,
  // skip billing quando set.
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
      // Sweep F49 2026-06-05: billing Whisper do SparkBot não cobrado (pouca $).
      reportError({ title: "SparkBot webhook: Whisper billing falhou", feature: "sparkbot-billing", severity: "medium", error: e });
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
    // Sweep F49 2026-06-05: histórico do rep não carregou → SparkBot amnésico
    // nessa conversa (responde sem contexto). Não-bloqueante.
    reportError({ title: "SparkBot webhook: leitura de histórico do rep falhou", feature: "sparkbot-history", severity: "medium", error: err });
  }

  // Reverte pra ordem cronológica (oldest first) e mapeia pra ConversationTurn.
  // FILTRA mensagens com content vazio — Claude rejeita com 400
  // "user messages must have non-empty content" e cai inteiro o turn pra
  // OpenAI fallback. Bug observado em prod 2026-05-03: webhooks WhatsApp
  // API multi-provider chegavam com body="" e era persistido vazio,
  // poluindo o histórico pra sempre.
  const conversationHistory: ConversationTurn[] = priorMsgs
    .reverse()
    .filter((m) => (m.content || "").trim().length > 0)
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
    // FIX 2026-05-03: NUNCA persistir content="" — Claude rejeita
    // history com 400. Webhook com body vazio e transcribe falho
    // viravam content="" e poluíam o histórico pra sempre.
    if (repInput.kind === "text") {
      return repInput.text.trim() || "[mensagem vazia]";
    }
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
  // (no sentido WhatsApp 24h tbm). H52: pausa do loop-guard NÃO é limpa
  // (helper compartilhado — ver resetSilenceTracking).
  try {
    const { resetSilenceTracking } = await import("@/lib/repositories/rep-identities.repo");
    await resetSilenceTracking(rep.id, new Date().toISOString());
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
        "high_only",
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
        // FIX 2026-05-03 (re-validação): ghl_contact_id também em role=agent.
        // O filtro `metadata->>ghl_contact_id` no recency check de REACTION
        // só funciona se ESTE campo existir nas msgs do agente — antes só
        // user msgs tinham, fazendo o check sempre retornar null e rejeitar
        // toda reação como "antiga".
        ghl_contact_id: contactId,
        model: result.model_used,
        tools: result.tools_executed,
        // H47-F0 (telemetria 2026-07-10): funil de resolução de contato (paridade stevo).
        contact_resolution: result.contact_resolution ?? null,
        // tool_calls completos (input + result) pra debug. Trunca cada
        // resultado a 800 chars pra não estourar jsonb. Cap em 30 calls
        // (Fix Pedro 2026-05-19: era 5, mascarava debug em turns com
        // muitos search+write em sequência tipo "cria nota nos 8 agentes").
        tool_calls: (result.tool_calls || []).slice(0, 30).map((tc) => ({
          name: tc.name,
          input: tc.input,
          result_preview: JSON.stringify(tc.result).slice(0, 800),
        })),
        prompt_tokens: result.tokens?.prompt,
        completion_tokens: result.tokens?.completion,
        cached_tokens: result.tokens?.cached,
        llm_failed: result.llm_failed,
        // Erros de fallback Claude→OpenAI pra debug
        ...(result.primary_error ? { primary_error: result.primary_error.slice(0, 500) } : {}),
        ...(result.secondary_error ? { secondary_error: result.secondary_error.slice(0, 500) } : {}),
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
