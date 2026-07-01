import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";

export const maxDuration = 60;
import { createAdminClient } from "@/lib/supabase/admin";
import { captureInboundWebhookSample } from "@/lib/account-assistant/inbound-webhook-capture";
import { detectChannel } from "@/lib/ghl/channel";
import {
  isProactiveEventsEnabled,
  isProactiveEventType,
  routeProactiveEvent,
} from "@/lib/account-assistant/proactive/event-router";

// ===== In-memory rate limiter =====
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // max 30 messages per contact per minute

// Eviction preguiçosa (cleanup 2026-06-10): o Map só crescia — contato que para
// de mandar mensagem deixava a entrada residente até o Vercel reciclar a
// instância. Em vez de setInterval (não cabe em serverless: o timer recicla
// junto com a lambda e não roda entre invokes), varremos as entradas expiradas
// no próprio hot path, amortizado a cada N chamadas. Como só removemos entradas
// com `now > resetAt` — exatamente as que o branch abaixo já trata como
// expiradas e sobrescreve — a semântica do rate limit fica IDÊNTICA (entrada
// podada == entrada reiniciada do zero no próximo inbound). Custo no caminho
// comum: 1 incremento + 1 comparação. Sweep O(n) só 1x a cada SWEEP_EVERY.
const RATE_LIMIT_SWEEP_EVERY = 500;
let rateLimitCallCount = 0;

function checkRateLimit(contactId: string): boolean {
  const now = Date.now();

  if (++rateLimitCallCount >= RATE_LIMIT_SWEEP_EVERY) {
    rateLimitCallCount = 0;
    // delete durante for..of de Map é seguro por spec (entrada já visitada/atual).
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(key);
    }
  }

  const entry = rateLimitMap.get(contactId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(contactId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// ===== Multi-hub Sparkbot lookup =====
// Antes: checava env var ASSISTANT_HUB_LOCATION_ID (single hub).
// Agora: query DB pra ver se a location tem agent type='account_assistant' ativo.
// Cache em memória 5min — agents raramente mudam, e webhook é hot path.
const HUB_CACHE_TTL_MS = 5 * 60 * 1000;
const hubCache = new Map<string, { isHub: boolean; expiresAt: number }>();

async function isSparkbotHub(locationId: string | undefined): Promise<boolean> {
  if (!locationId) return false;
  const now = Date.now();
  const cached = hubCache.get(locationId);
  if (cached && cached.expiresAt > now) return cached.isHub;

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("agents")
      .select("id")
      .eq("location_id", locationId)
      .eq("type", "account_assistant")
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    const isHub = !!data && !error;
    hubCache.set(locationId, { isHub, expiresAt: now + HUB_CACHE_TTL_MS });
    return isHub;
  } catch (err) {
    console.warn("[Webhook:isSparkbotHub] lookup falhou — assumindo não é hub:", err instanceof Error ? err.message : err);
    return false;
  }
}
import { GHLClient } from "@/lib/ghl/client";
import { extractAudioUrl } from "@/lib/ai/audio-transcriber";
import { extractMediaAttachments } from "@/lib/ai/media-extractor";
import { processMessageQueue } from "@/lib/queue/queue-processor";
import { checkContactMatchesTargeting, normalizeTargeting } from "@/lib/queue/targeting";
import { classifyLastOutbound, extractAiSentTexts } from "@/lib/queue/human-takeover";
import { NON_HUMAN_SOURCES } from "@/lib/ghl/message-sources";
import { reportError } from "@/lib/admin-signals/report-error";
import type { TargetingRules } from "@/types/agent";

// ===== Cutover Stevo (Pedro 2026-05-20) =====
// Quando SPARKBOT_INBOUND_PRIMARY="stevo", o recebimento do Hub passa a ser
// servido pelo webhook do Stevo (que entrega o binário decriptado + responde
// via /send/text). Este path GHL vira FALLBACK: ignora o inbound do Hub pra
// NÃO processar/responder em dobro (o GHL e o Stevo disparam os dois pro mesmo
// inbound). Default (env ausente ou "ghl") = GHL primário, comportamento atual
// inalterado. Pareia com STEVO_SEND_ENABLED no stevo-handler: ligar os DOIS no
// cutover supervisionado; desligar qualquer um faz rollback imediato.
function isStevoInboundPrimary(): boolean {
  return (process.env.SPARKBOT_INBOUND_PRIMARY || "").trim().toLowerCase() === "stevo";
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.error("[Webhook] JSON parse failed");
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    // ===== SEGURANÇA: Validar origem =====
    // Se GHL_WEBHOOK_SECRET está setado, signature é OBRIGATÓRIA.
    // Se não está setado + WEBHOOK_REQUIRE_SIGNATURE=true, bloqueia tudo (fail-closed em prod).
    // Se nenhum dos dois, aceita sem verificar (só usar em dev).
    const webhookSecret = process.env.GHL_WEBHOOK_SECRET;
    const requireSignature = process.env.WEBHOOK_REQUIRE_SIGNATURE === "true";

    if (webhookSecret) {
      const signature = request.headers.get("x-ghl-signature") ||
        request.headers.get("x-signature") ||
        request.headers.get("x-webhook-signature");

      if (!signature) {
        console.warn("[Webhook] Missing signature header — rejecting (secret is configured)");
        return NextResponse.json({ error: "missing_signature" }, { status: 401 });
      }

      const { createHmac, timingSafeEqual } = await import("crypto");
      const expectedSig = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
      const sigBuf = Buffer.from(signature, "utf8");
      const expBuf = Buffer.from(expectedSig, "utf8");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        console.warn("[Webhook] Invalid signature — rejecting");
        return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
      }
    } else if (requireSignature) {
      console.error("[Webhook] WEBHOOK_REQUIRE_SIGNATURE=true mas GHL_WEBHOOK_SECRET não configurado — rejeitando");
      return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
    } else {
      // Pedro 2026-05-28 (F20): GHL não usa secret HMAC pra inbound webhook
      // (usa Ed25519 público, que ainda não implementamos). Em vez de assinar,
      // aplicamos mitigações defensivas:
      //   1. Rate limit por IP (50/min) — checkWebhookRateLimit logo abaixo
      //   2. Cost circuit breaker — mesma função
      //   3. Anomaly signal (>5 IPs únicos/min/location) — dentro do helper
      // Não dispara signal sobre "secret faltando" porque secret HMAC não é
      // o esquema do GHL — seria mensagem confusa.
      console.warn("[Webhook] No HMAC signature (GHL usa Ed25519 público — implementação pendente). Mitigações defensivas ativas.");
    }

    // F20 (Pedro 2026-05-28): rate limit por IP + cost circuit breaker.
    // Bloqueia DDoS trivial sem signature.
    const xForwardedFor = request.headers.get("x-forwarded-for") || "";
    const clientIp = xForwardedFor.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
    const locId = (body.locationId || body.location_id) as string | undefined;
    {
      const { checkWebhookRateLimit } = await import("@/lib/webhooks/rate-limit");
      const rlCheck = await checkWebhookRateLimit(clientIp, locId || null);
      if (!rlCheck.allowed) {
        console.warn(
          `[Webhook] BLOCKED ${rlCheck.reason} ip=${clientIp.slice(0, 20)} loc=${locId?.slice(0, 8) || "—"} count=${rlCheck.current_count}/${rlCheck.cap}`,
        );
        if (rlCheck.reason === "rate_limit") {
          return NextResponse.json({ error: "rate_limited" }, { status: 429 });
        }
        // cost_cap: bot continua respondendo mesmo com cap atingido seria
        // runaway. Aqui hard-stop até reset mensal ou admin aumentar cap.
        return NextResponse.json({ error: "cost_cap_reached" }, { status: 402 });
      }
    }

    // ===== PARSING =====
    const locationId = (body.locationId || body.location_id) as string | undefined;
    const contactId = (body.contactId || body.contact_id || (body.customData as Record<string, unknown>)?.contact_id) as string | undefined;
    const conversationId = (body.conversationId || body.conversation_id) as string | undefined;
    const messageBody = (body.body || body.message || (body.customData as Record<string, unknown>)?.message) as string | undefined;
    const messageType = (body.messageType || body.type || "SMS") as string;
    const direction = (body.direction || "inbound") as string;

    console.log(`[Webhook] ${direction} | type=${messageType} | loc=${locationId} | contact=${contactId} | body="${(messageBody || "").substring(0, 50)}"`);

    // Log RAW de campos de midia para diagnostico
    const rawMediaFields = {
      attachments: body.attachments,
      Attachments: body.Attachments,
      mediaUrl: body.mediaUrl,
      media_url: body.media_url,
      contentType: body.contentType,
      messageType: body.messageType,
    };
    const hasAnyMedia = Object.values(rawMediaFields).some(v => v != null && v !== "" && v !== undefined);
    if (hasAnyMedia) {
      console.log(`[Webhook:RAW] Media fields:`, JSON.stringify(rawMediaFields).substring(0, 800));
    }

    // ===== CAPTURA RAW (diagnóstico — Pedro 2026-05-24) =====
    // Grava o payload ANTES de qualquer skip, pra confirmar se o GHL encaminha
    // as DMs (IG etc) pra gente e com qual payload. Fire-and-forget, non-fatal,
    // gated por INBOUND_WEBHOOK_CAPTURE (default ON). Tabela inbound_webhook_samples.
    void captureInboundWebhookSample({
      locationId,
      contactId,
      messageType,
      detectedChannel: detectChannel(
        messageType,
        (body.customData as Record<string, unknown>)?.channel as string | undefined,
      ),
      messageDirection: direction,
      isRealMessage: isRealMessage(messageType, direction),
      raw: body,
    });

    // ===== PROATIVIDADE EVENT-DRIVEN (Pedro 2026-05-21) =====
    // GHL manda webhooks de task/opp/appointment/contact que NÃO são mensagens.
    // Em vez de só descartar, roteia pra proatividade (gated por env, non-fatal,
    // fire-and-forget). O fluxo de mensagem segue IDÊNTICO — o isRealMessage abaixo
    // continua descartando esses tipos. Default OFF até o smoke supervisionado.
    if (isProactiveEventsEnabled() && isProactiveEventType(messageType)) {
      void routeProactiveEvent(body as Record<string, unknown>, messageType).catch((err) =>
        console.warn(
          "[proactive-router] falhou (non-fatal):",
          err instanceof Error ? err.message : err,
        ),
      );
    }

    // ===== FILTRO: Apenas mensagens reais =====
    if (!isRealMessage(messageType, direction)) {
      console.log(`[Webhook] Skipped: not_a_real_message (type=${messageType})`);
      return NextResponse.json({ received: true, skipped: "not_a_real_message" });
    }

    // ===== AUDIO: Extrair URL se for mensagem de voz =====
    const audioInfo = extractAudioUrl(body);
    const audioUrl = audioInfo?.url || null;
    const audioMimeType = audioInfo?.mimeType || null;

    // Log completo para debugging de audio
    const hasAttachments = Array.isArray(body.attachments) && (body.attachments as unknown[]).length > 0;
    const hasMediaUrl = !!(body.mediaUrl || body.media_url);
    if (audioUrl) {
      console.log(`[Webhook] Audio detected: ${audioUrl} (mime: ${audioMimeType})`);
    } else if (hasAttachments || hasMediaUrl) {
      console.log(`[Webhook] Media present but not detected as audio:`, JSON.stringify({
        attachments: body.attachments,
        mediaUrl: body.mediaUrl || body.media_url,
        contentType: body.contentType,
        messageType,
      }).substring(0, 500));
    }

    // ===== MIDIA: Extrair imagens e documentos =====
    const mediaAttachments = extractMediaAttachments(body);
    if (mediaAttachments.length > 0) {
      console.log(`[Webhook] Media detected: ${mediaAttachments.map(m => m.contentType).join(", ")}`);
    }

    // ===== VALIDAÇÃO: Campos obrigatórios =====
    // F50 (Fix bug observado em prod 2026-06-04): o requisito de CONTEÚDO
    // (texto/áudio/mídia) é só pro INBOUND — que precisa de algo pra processar.
    // Pro OUTBOUND, a detecção de "humano assumiu" (auto_pause_on_human_message)
    // mora no branch direction==="outbound" mais abaixo e NÃO precisa do conteúdo:
    // basta saber que um humano mandou ALGO. Antes, um áudio manual do rep (sem
    // texto, e cujo áudio outbound nem sempre é extraível) caía aqui em
    // "missing_fields" e NUNCA chegava na lógica de pausa. Agora outbound passa.
    const needsContent = direction === "inbound";
    if (!locationId || !contactId || (needsContent && !messageBody && !audioUrl && mediaAttachments.length === 0)) {
      console.log(`[Webhook] Skipped: missing_fields (loc=${locationId}, contact=${contactId}, dir=${direction}, body=${!!messageBody}, audio=${!!audioUrl})`);
      return NextResponse.json({ received: true, skipped: "missing_fields" });
    }

    // Validar formato dos IDs (aceita alfanumerico, hifens, underscores)
    if (!/^[\w-]{2,100}$/.test(locationId) || !/^[\w-]{2,100}$/.test(contactId)) {
      console.log(`[Webhook] Skipped: invalid_ids (loc=${locationId}, contact=${contactId})`);
      return NextResponse.json({ received: true, skipped: "invalid_ids" });
    }

    // ===== RATE LIMIT: Inbound messages per contact =====
    if (direction === "inbound" && !checkRateLimit(contactId)) {
      console.warn(`[Webhook] Rate limited: contact ${contactId}`);
      return NextResponse.json({ received: true, skipped: "rate_limited" });
    }

    // ===== SPARKBOT ROUTE: mensagens pra Hub location do Account Assistant =====
    // Reusa o mesmo webhook do GHL Marketplace app — só roteia internamente.
    // Pula STOP/handoff/targeting (específicos de sales/recruitment) e delega
    // pro handler dedicado.
    //
    // Multi-hub: aceita QUALQUER location que tenha agent ativo
    // type='account_assistant'. Antes era checado via env var
    // ASSISTANT_HUB_LOCATION_ID (single hub) — bloqueava agências com mais
    // de um hub Sparkbot (ex: WhatsApp via Stevo numa location dedicada).
    // Cache em memória 5min pra evitar query a cada webhook.
    if (await isSparkbotHub(locationId)) {
      // Cutover: se o Stevo é o primário, o GHL não processa o inbound do Hub
      // (vira fallback). Só inbound — outbound o handler já ignora internamente.
      if (direction === "inbound" && isStevoInboundPrimary()) {
        console.log(
          `[Webhook] Sparkbot inbound suprimido — Stevo é primário (loc=${locationId}, contact=${contactId})`,
        );
        return NextResponse.json({ received: true, skipped: "stevo_primary" });
      }
      const { handleAssistantInbound } = await import("@/lib/account-assistant/webhook-handler");
      waitUntil(
        handleAssistantInbound({
          hubLocationId: locationId,
          contactId,
          conversationId: conversationId || "",
          messageBody: messageBody || "",
          messageType,
          direction,
          body,
        }).catch((err) => {
          console.error("[Sparkbot:bg] handler failed:", err instanceof Error ? err.message : err);
          // F49: falha do handler vira IDENTIFICÁVEL (signal + Sentry), não só log.
          reportError({
            title: "SparkBot: handler do inbound falhou (GHL)",
            error: err,
            feature: "sparkbot-inbound-ghl",
            severity: "critical",
            metadata: { location_id: locationId, contact_id: contactId, message_type: messageType },
          });
        }),
      );
      return NextResponse.json({ received: true, routed: "sparkbot" });
    }

    // ===== STOP/opt-out compliance — intercept before any processing =====
    if (direction === "inbound" && messageBody) {
      const stopKeywords = ["stop", "parar", "cancelar", "sair", "unsubscribe", "opt out", "nao me procure", "não me procure"];
      const bodyLower = (messageBody || "").toLowerCase().trim();
      if (stopKeywords.includes(bodyLower)) {
        const supabaseStop = createAdminClient();
        const nowIso = new Date().toISOString();

        // Buscar agentes ativos da location para garantir opt-out mesmo
        // sem conversation_state existente
        const { data: activeAgents } = await supabaseStop
          .from("agents")
          .select("id")
          .eq("location_id", locationId)
          .eq("status", "active")
          .in("type", ["sales_agent", "recruitment_agent", "custom_agent"]);

        for (const agent of activeAgents || []) {
          await supabaseStop
            .from("conversation_state")
            .upsert({
              agent_id: agent.id,
              location_id: locationId,
              contact_id: contactId,
              conversation_id: conversationId || "",
              status: "disqualified",
              ai_paused_at: nowIso,
              ai_paused_reason: "opt_out:" + bodyLower,
              updated_at: nowIso,
            }, { onConflict: "agent_id,contact_id" });
        }

        console.log(`[Webhook] Opt-out: contact ${contactId} sent "${bodyLower}" — ${(activeAgents || []).length} agent(s) paused`);
        return NextResponse.json({ received: true, skipped: "opt_out" });
      }
    }

    if (direction === "outbound") {
      // ===== DETECÇÃO DE MENSAGEM HUMANA (HANDOFF) =====
      // GHL envia campo "source" e "userId" no payload do webhook:
      //   - source="app" + userId presente = humano enviou pelo CRM
      //   - source="api" = enviado via API (nossa IA)
      //   - source="workflow"/"campaign"/"bulk"/"automation"/"scheduled"/... =
      //     automação do GHL (welcome de lead novo, re-engajamento, etc).
      //
      // Combinamos source/userId com heurística anti-eco como fallback.
      const webhookSource = (body.source || "") as string;
      const webhookUserId = (body.userId || body.user_id || "") as string;
      const isFromGhlApp = webhookSource === "app" && !!webhookUserId;

      // Fix bug 2026-06-10 (paridade F51↔F52): antes a checagem era estreita —
      // só `source==="api" || source==="workflow"` early-retornava. Um outbound
      // carimbado "campaign"/"bulk"/"automation"/"scheduled" (ex.: welcome de
      // campanha pra um lead NOVO) furava o early return, caía no anti-eco abaixo
      // e — como a IA ainda não tinha falado (aiResponses vazio) — virava
      // isHumanMessage=true, PAUSANDO a IA em todo lead novo com auto_pause
      // ligado. É a mesma classe de bug que o F52/F56 matou no ladder do
      // queue-processor, só disparada por outro rótulo de source. Agora consome a
      // FONTE ÚNICA NON_HUMAN_SOURCES (automação + "api", case-insensitive) de
      // @/lib/ghl/message-sources — a MESMA base (AUTOMATION_SOURCES) que o
      // classifyLastOutbound do F52 usa, então o webhook (F51) e o ladder do
      // histórico (F52) não conseguem mais divergir no conjunto de fontes.
      const isNonHumanSource = NON_HUMAN_SOURCES.has(String(webhookSource).toLowerCase());

      console.log(`[Webhook:outbound] contact=${contactId} | source="${webhookSource}" | userId="${webhookUserId}" | isApp=${isFromGhlApp} | nonHuman=${isNonHumanSource} | body="${(messageBody || "").substring(0, 40)}"`);

      // Source de api ou automação = nossa IA ou automação do GHL → ignorar
      // (nunca é handoff humano). app/desconhecido segue pro anti-eco abaixo.
      if (isNonHumanSource) {
        return NextResponse.json({ received: true, skipped: "outbound_non_human" });
      }

      try {
        const supabaseAdmin = createAdminClient();

        // Resolver o agente pelo conversation_state do contato
        const { data: existingStates } = await supabaseAdmin
          .from("conversation_state")
          .select("agent_id")
          .eq("location_id", locationId)
          .eq("contact_id", contactId);

        let outboundAgent: { id: string; agent_configs: unknown } | null = null;

        const stateAgentIds = (existingStates || []).map((r) => r.agent_id).filter(Boolean);
        if (stateAgentIds.length > 0) {
          // Fix CRITICAL stress test 2026-05-03: maybeSingle() throws quando
          // .in() retorna 2+ rows (contato com 2 conversation_states ativos
          // — sales+recruitment). Trocado por array + pick first.
          const { data: pickedArr } = await supabaseAdmin
            .from("agents")
            .select("id, agent_configs(handoff_messages, auto_pause_on_human_message)")
            .in("id", stateAgentIds)
            .eq("status", "active")
            .limit(1);
          if (pickedArr && pickedArr[0]) outboundAgent = pickedArr[0] as { id: string; agent_configs: unknown };
        }

        // Fallback: exatamente 1 agente ativo na location
        if (!outboundAgent) {
          const { data: active } = await supabaseAdmin
            .from("agents")
            .select("id, agent_configs(handoff_messages, auto_pause_on_human_message)")
            .eq("location_id", locationId)
            .eq("status", "active")
            .in("type", ["sales_agent", "recruitment_agent", "custom_agent"]);
          if (active && active.length === 1) {
            outboundAgent = active[0] as { id: string; agent_configs: unknown };
          }
        }

        if (outboundAgent) {
          const outboundConfig = Array.isArray(outboundAgent.agent_configs)
            ? outboundAgent.agent_configs[0]
            : outboundAgent.agent_configs;

          const autoPauseEnabled = outboundConfig?.auto_pause_on_human_message === true;
          const handoffMessages = (outboundConfig?.handoff_messages || []) as {
            id: string; label: string; text: string; auto_deactivate: boolean;
          }[];

          // Determinar se é mensagem humana via a LADDER UNIFICADA
          // classifyLastOutbound (FONTE ÚNICA com o F52 do queue-processor).
          // Fix bug observado em prod 2026-06-18 (caso Marina): aqui usava-se
          // `isAiEcho` CRU — que NÃO tem o discriminador "IA nunca falou → não é
          // humano" (disc 4 da ladder). Resultado: quando o eco do próprio envio
          // multi-parte da IA chegava ANTES do send_message ser logado (race) OU
          // num contato onde a IA ainda não tinha falado, isAiEcho dava false →
          // isHuman=true → pausa espúria. 35 contatos desta location ficaram
          // pausados com reason auto_pause:human_message e message_count=0.
          // A ladder cobre: automação (disc 1), eco da IA (disc 2), userId de
          // user GHL (disc 3), IA-nunca-falou (disc 4), mídia pós-IA (disc 5).
          // (source api/automação já retornou cedo lá em cima — chega aqui só
          // app/desconhecido.) isFromGhlApp sozinho NÃO basta.
          void isFromGhlApp;
          const ninetySecondsAgo = new Date(Date.now() - 90_000).toISOString();
          const { data: aiResponses } = await supabaseAdmin
            .from("execution_log")
            .select("action_payload")
            .eq("location_id", locationId)
            .eq("contact_id", contactId)
            .eq("action_type", "send_message")
            .eq("success", true)
            .gte("created_at", ninetySecondsAgo)
            .order("created_at", { ascending: false })
            .limit(10);

          const aiTexts = extractAiSentTexts(aiResponses);
          const { isHuman } = classifyLastOutbound({
            lastOutbound: { body: messageBody, userId: webhookUserId, source: webhookSource },
            aiTexts,
          });
          // Reforço anti-eco (Pedro 2026-06-18, caso Marina): a IA manda em VÁRIAS
          // partes no IG; o eco volta em segundos, às vezes mangled (não bate o
          // texto) E com o userId do admin (GHL carimba o api-send como app+user).
          // Se a IA enviou nos últimos ~90s (aiResponses não vazio), presumimos eco
          // e NÃO pausamos — nem com userId. Só consideramos handoff humano quando
          // a IA NÃO acabou de falar. (Janela curta: handoff humano logo após a IA
          // é raro; o rep sempre pode pausar manual no pill.) Mata a auto-pausa que
          // mutou 39 leads.
          const aiSentRecently = aiTexts.length > 0;
          const isHumanMessage = isHuman && !aiSentRecently;

          console.log(`[Webhook:outbound] isHuman=${isHumanMessage} | autoPause=${autoPauseEnabled} | agent=${outboundAgent.id}`);

          let pauseReason: string | null = null;

          if (autoPauseEnabled && isHumanMessage) {
            pauseReason = `auto_pause:human_message${webhookUserId ? `:user_${webhookUserId}` : ""}`;
          } else if (!autoPauseEnabled && isHumanMessage) {
            const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
            const bodyNorm = normalize(messageBody || "");
            const matched = handoffMessages.find(
              (m) => m.auto_deactivate && normalize(m.text) === bodyNorm
            );
            if (matched) pauseReason = `handoff_message:${matched.label}`;
          }

          if (pauseReason) {
            console.log(`[Webhook:outbound] PAUSANDO IA: ${pauseReason} | contact=${contactId}`);
            const nowIso = new Date().toISOString();
            await supabaseAdmin
              .from("conversation_state")
              .upsert(
                {
                  agent_id: outboundAgent.id,
                  location_id: locationId,
                  contact_id: contactId,
                  conversation_id: conversationId || "",
                  status: "handed_off",
                  ai_paused_at: nowIso,
                  ai_paused_reason: pauseReason,
                  updated_at: nowIso,
                },
                { onConflict: "agent_id,contact_id" }
              );

            console.log(`[Handoff] IA pausada para contato ${contactId} (${pauseReason})`);

            // Gerar nota de resumo (non-blocking via waitUntil)
            waitUntil(
              (async () => {
                try {
                  const locData = await supabaseAdmin.from("locations").select("company_id").eq("location_id", locationId).single();
                  if (!locData.data) return;
                  const { generateSummaryNote } = await import("@/lib/queue/summary-note-generator");
                  await generateSummaryNote({
                    agentId: outboundAgent!.id,
                    locationId: locationId,
                    contactId: contactId,
                    conversationId: conversationId || "",
                    companyId: locData.data.company_id,
                    triggerReason: "handed_off",
                    aiModel: "gpt-4.1-mini",
                  });
                } catch (err) {
                  console.error("[Webhook] Summary note error:", err);
                }
              })()
            );

            return NextResponse.json({
              received: true,
              skipped: "outbound_handoff_triggered",
              paused: true,
              reason: pauseReason,
            });
          }
        }
      } catch (error) {
        console.error("[Handoff] Erro ao processar outbound:", error);
        // Sweep F49 2026-06-05: handoff outbound é best-effort (retorna mesmo),
        // mas a pausa-on-humano pode não ter sido aplicada.
        reportError({ title: "Inbound webhook: erro ao processar handoff outbound", feature: "sparkbot-handoff", severity: "medium", error });
      }

      return NextResponse.json({ received: true, skipped: "outbound" });
    }

    const channel = detectChannel(messageType, (body.customData as Record<string, unknown>)?.channel as string | undefined);
    const supabase = createAdminClient();

    // ===== BUSCAR TODOS os agentes ativos (sales + recruitment) =====
    // Nao podemos mais pegar "o primeiro" — sales e recrutamento sao
    // totalmente separados. Precisamos decidir explicitamente qual agente
    // recebe esta mensagem:
    //   1) Se ja existe conversation_state para este contato -> esse agente
    //   2) Senao, iterar por ordem (sales primeiro por historico) e selecionar
    //      o primeiro agente cujas targeting_rules batem
    //   3) Se nenhum bater, skip
    const { data: allAgents } = await supabase
      .from("agents")
      .select("id, type, location_id, agent_configs(debounce_seconds, targeting_rules, enabled_channels, deactivation_rules, working_hours)")
      .eq("location_id", locationId)
      .eq("status", "active")
      .in("type", ["sales_agent", "recruitment_agent", "custom_agent"]);

    if (!allAgents || allAgents.length === 0) {
      console.log(`[Webhook] Skipped: no_active_agent for location ${locationId} (contact ${contactId}, ${channel})`);
      // Loop de qualidade 2026-06-29 (iter-1, redução de ruído de observabilidade):
      // lead-facing é pago/opt-in → a MAIORIA das locations não tem agente, então
      // este caso era ESPERADO mas virava admin_signal em TODO inbound (60.812
      // ocorrências afogando o painel, sem caminho de escalação/push). Rebaixado pra
      // console-only. O caso real "agente que DEVIA estar ativo foi pausado" não era
      // pego por um sinal de 60k/mês — é melhor via reclamação do rep + smoke.
      // (O sinal IRMÃO 'nenhum agente casou targeting' fica — esse TEM push em occ>=20
      // e pega o bug F27 do agente-mudo.) Ver _planning/daily-quality-loop/PLANO.md.
      return NextResponse.json({ received: true, skipped: "no_active_agent" });
    }
    console.log(`[Webhook] Found ${allAgents.length} active agent(s): ${allAgents.map(a => a.type).join(", ")}`);

    // 1) Agente já dono da conversa — PREFERIR o que está ATIVO (não pausado).
    // Fix bug observado em prod 2026-06-10 (Alves Cury): com 2 agentes lead
    // (vendas+recrut) no mesmo contato, o seletor único da pílula (GU-7) liga 1
    // e pausa o outro — mas aqui pegávamos "o PRIMEIRO com conversation_state",
    // que podia ser o PAUSADO (recrut pausado pelo F52). Resultado: o inbound
    // caía no agente errado e ninguém respondia, mesmo o rep tendo ligado vendas.
    // Agora: ativo (ai_paused_at NULL) ganha do pausado; entre ativos, o
    // updated_at mais recente (= o último escolhido na pílula).
    const { data: existingStates } = await supabase
      .from("conversation_state")
      .select("agent_id, ai_paused_at, updated_at")
      .eq("location_id", locationId)
      .eq("contact_id", contactId);

    const states = ((existingStates || []) as Array<{
      agent_id: string | null;
      ai_paused_at: string | null;
      updated_at: string | null;
    }>).filter((r) => r.agent_id);

    type AgentRow = typeof allAgents[number];
    let selectedAgent: AgentRow | null = null;

    if (states.length > 0) {
      const ranked = [...states].sort((a, b) => {
        const aActive = a.ai_paused_at ? 0 : 1;
        const bActive = b.ai_paused_at ? 0 : 1;
        if (aActive !== bActive) return bActive - aActive; // ativo primeiro
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      });
      for (const st of ranked) {
        const found = allAgents.find((a) => a.id === st.agent_id);
        if (found) {
          selectedAgent = found;
          break;
        }
      }
    }

    // Precisamos da location para checar targeting
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", locationId)
      .single();

    if (!location) {
      console.log(`[Webhook] Skipped: location_not_found (${locationId})`);
      // Sweep 2026-06-17: há agentes ativos referenciando esta location, mas
      // ela não está na tabela `locations` — drift/misconfig. Lead fica mudo.
      reportError({
        title: "Inbound: location do webhook não está cadastrada",
        feature: "inbound-webhook",
        severity: "high",
        description: "Chegou inbound (com agente ativo) mas a location não existe na tabela locations. Lead sem resposta — verificar sync de locations / wiring do webhook.",
        metadata: { location_id: locationId, contact_id: contactId },
      });
      return NextResponse.json({ received: true, skipped: "location_not_found" });
    }

    // 2) Rotear por targeting quando nao houver conversa anterior.
    // Agente COM regra que bate sempre ganha do fallback (sem regra = catch-all).
    if (!selectedAgent) {
      let fallback: typeof allAgents[number] | null = null;
      let ruleless = 0;
      for (const candidate of allAgents) {
        const cfg = Array.isArray(candidate.agent_configs)
          ? candidate.agent_configs[0]
          : candidate.agent_configs;
        const rawRules = (cfg?.targeting_rules ?? null) as TargetingRules | null;
        // Unificado com o gate de runtime (Pedro 2026-06-17): MESMO avaliador
        // (tag/custom_field/pipeline_stage/MESSAGE + grupos E/OU). normalizeTargeting
        // cobre array legado E set v2; null = sem regra = catch-all/fallback.
        if (!normalizeTargeting(rawRules)) {
          ruleless++;
          if (!fallback) fallback = candidate; // 1º sem-regra = catch-all
          continue;
        }
        // failMode "closed": no ROTEAMENTO, erro de fetch = "não escolhe ESTE
        // agente" (não atende quem talvez não devia — tenta o próximo). messageBody
        // alimenta as folhas type="message" → agente com filtro de mensagem É
        // selecionável pro lead novo (antes o roteador divergente nem conhecia).
        const matches = (
          await checkContactMatchesTargeting(contactId, rawRules, location.company_id, locationId, {
            messageText: messageBody || "",
            failMode: "closed",
          })
        ).ok;
        if (matches) {
          selectedAgent = candidate;
          break;
        }
      }
      if (!selectedAgent && fallback) {
        selectedAgent = fallback;
        // Diagnóstico: 2+ agentes sem regra disputam o mesmo inbound — o 1º
        // "engole" tudo e o outro nunca recebe. Resolva dando targeting (tag/
        // etapa) a cada agente. (ultra-review 2026-05-26)
        if (ruleless > 1) {
          console.warn(`[Webhook] ${ruleless} agentes lead SEM targeting na location ${locationId} — '${fallback.type}' (${fallback.id}) pegou o lead; os outros ficam sem inbound. Configure targeting por agente.`);
        }
      }
    }

    if (!selectedAgent) {
      console.log(`[Webhook] Skipped: no_agent_matched_targeting for contact ${contactId}`);
      // Sweep 2026-06-17: há agentes ativos mas NENHUM casou o targeting deste
      // contato — provável targeting estreito demais (classe de bug F27/RV-W:
      // agente mudo). MEDIUM: empurra push se virar padrão (occ>=20).
      reportError({
        title: "Inbound: nenhum agente casou o targeting do contato",
        feature: "inbound-webhook",
        severity: "medium",
        description: "Existem agentes lead-facing ativos mas as targeting_rules de todos excluíram este contato. Se for engano, afrouxe o targeting (tag/etapa/campo).",
        metadata: { location_id: locationId, contact_id: contactId, channel, active_agents: allAgents.length },
      });
      return NextResponse.json({ received: true, skipped: "no_agent_matched_targeting" });
    }
    console.log(`[Webhook] Selected agent: ${selectedAgent.type} (${selectedAgent.id})`);

    const agent = selectedAgent;
    const config = Array.isArray(agent.agent_configs)
      ? agent.agent_configs[0]
      : agent.agent_configs;

    const debounceSeconds = config?.debounce_seconds || 15;
    const enabledChannels: string[] = config?.enabled_channels || ["SMS", "WhatsApp"];

    // ===== FILTRO: Canal habilitado =====
    if (!enabledChannels.includes(channel)) {
      console.log(`[Webhook] Skipped: channel_not_enabled (${channel} not in [${enabledChannels}])`);
      // Sweep 2026-06-17: lead mandou por um canal que o agente não tem
      // habilitado (ex: Instagram DM). O agente fica mudo nesse canal. MEDIUM —
      // surfaceia a decisão de habilitar o canal por agente.
      reportError({
        title: "Inbound: canal não habilitado no agente (lead sem resposta)",
        feature: "inbound-webhook",
        severity: "medium",
        description: `Lead mandou pelo canal "${channel}" mas o agente ${agent.type} só tem [${enabledChannels.join(", ")}] habilitado(s). Habilite o canal na config se for pra responder.`,
        metadata: { location_id: locationId, contact_id: contactId, channel, enabled_channels: enabledChannels, agent_id: agent.id },
      });
      return NextResponse.json({ received: true, skipped: "channel_not_enabled" });
    }

    // ===== FILTRO: Regras de desligamento (agente ja selecionado) =====
    const deactivationRules = config?.deactivation_rules || [];
    if (deactivationRules.length > 0) {
      const shouldDeactivate = await checkDeactivationRules(
        deactivationRules, contactId, location.company_id, locationId
      );
      if (shouldDeactivate) {
        return NextResponse.json({ received: true, skipped: "deactivated_by_rule" });
      }
    }

    // ===== FILTRO: Working hours =====
    // Fix HIGH-13 (deep review 2026-05-05): antes, msg fora do expediente
    // era SKIPPED silenciosamente — bot nunca respondia, lead ficava sem
    // resposta. Agora enfileiramos com process_after = início próximo
    // expediente, cron pega quando volta. Se nextWorkingHourStart der null
    // (schedule todo disabled — config inválida), aí sim skip + log.
    const wh = config?.working_hours;
    let workingHoursDelay: string | null = null;
    if (wh?.enabled && !isWithinWorkingHours(wh)) {
      workingHoursDelay = nextWorkingHourStart(wh);
      if (!workingHoursDelay) {
        console.warn(
          `[Webhook] Working hours config inválida (todos disabled?) — skipping. location=${locationId}`,
        );
        return NextResponse.json({ received: true, skipped: "outside_working_hours_no_window" });
      }
      console.log(
        `[Webhook] Outside working hours — enqueueing pra ${workingHoursDelay} (location=${locationId})`,
      );
    }

    // ===== DEBOUNCE ATÔMICO: usar RPC ou transação =====
    // Se fora do expediente, process_after = início próximo dia útil.
    // Senão, debounce normal.
    const processAfter = workingHoursDelay
      ? workingHoursDelay
      : new Date(Date.now() + debounceSeconds * 1000).toISOString();
    const now = new Date().toISOString();

    // Atualizar pendentes + inserir nova em uma sequência atômica
    // Primeiro inserir a mensagem (com agent_id explicito — crucial para
    // evitar cross-contamination no processor)
    // Montar payload — campos opcionais (channel, audio) so entram se
    // as colunas existirem na tabela (evita 400 por schema desatualizado).
    const queuePayload: Record<string, unknown> = {
      agent_id: agent.id,
      location_id: locationId,
      contact_id: contactId,
      conversation_id: conversationId || "",
      message_body: messageBody || (audioUrl ? "[audio]" : mediaAttachments.length > 0 ? "[media]" : ""),
      message_type: messageType,
      message_direction: direction,
      // Fix bug observado em prod 2026-06-16 (Alves Cury, lead 959-236-9723 — agente
      // respondendo 2×): o conversation-provider (Stevo/dual-app) entrega cada inbound
      // 2× e usa `messageId`, NÃO `id`. Como só líamos body.id, ghl_message_id virava
      // null → o índice UNIQUE de dedup (00021, parcial WHERE ghl_message_id IS NOT
      // NULL) não pegava → 2 linhas no message_queue → 2 processamentos → resposta
      // duplicada pro lead. Os 2 webhooks carregam o MESMO messageId, então ler ele
      // como fallback faz o 2º insert bater 23505 e ser descartado.
      ghl_message_id: (body.id as string) || (body.messageId as string) || null,
      received_at: now,
      process_after: processAfter,
      status: "pending",
    };

    // Campos adicionados em migrations recentes — tenta inserir e faz
    // fallback sem eles se o schema cache ainda nao atualizou.
    if (channel) queuePayload.channel = channel;
    if (audioUrl) queuePayload.audio_url = audioUrl;
    if (audioMimeType) queuePayload.audio_mime_type = audioMimeType;
    if (mediaAttachments.length > 0) queuePayload.media_attachments = mediaAttachments;

    let { error: insertError } = await supabase.from("message_queue").insert(queuePayload);

    // Dedup: se o erro for unique constraint (webhook retry), skip silenciosamente
    if (insertError && insertError.code === "23505") {
      console.log(`[Webhook] Duplicate message ignored (ghl_message_id already exists)`);
      return NextResponse.json({ received: true, skipped: "duplicate" });
    }

    // Fallback: se falhou por outro motivo, tentar sem os campos opcionais
    if (insertError) {
      console.warn("[Webhook] Insert failed, retrying without optional columns:", insertError.message);
      if (audioUrl && queuePayload.message_body === "[audio]") {
        queuePayload.message_body = `[audio: ${audioUrl}]`;
      }
      delete queuePayload.channel;
      delete queuePayload.audio_url;
      delete queuePayload.audio_mime_type;
      delete queuePayload.media_attachments;
      const retry = await supabase.from("message_queue").insert(queuePayload);
      insertError = retry.error;
      // Dedup no fallback tambem
      if (insertError && insertError.code === "23505") {
        return NextResponse.json({ received: true, skipped: "duplicate" });
      }
    }

    if (insertError) {
      console.error("[Webhook] Insert failed definitively:", insertError);
      return NextResponse.json({ error: "queue_insert_failed", detail: insertError.message }, { status: 500 });
    }

    // Depois empurrar TODAS as pendentes do MESMO agente + contato
    await supabase
      .from("message_queue")
      .update({ process_after: processAfter })
      .eq("agent_id", agent.id)
      .eq("contact_id", contactId)
      .eq("status", "pending");

    console.log(`[Webhook] Queued for ${agent.type} | debounce=${debounceSeconds}s | channel=${channel}`);

    // Processar fila apos debounce usando waitUntil (mantém a função
    // viva no background mesmo depois de retornar a resposta).
    waitUntil(
      sleep(debounceSeconds * 1000 + 2000).then(async () => {
        try {
          console.log("[Webhook:bg] Processing queue after debounce...");
          const result = await processMessageQueue();
          console.log(`[Webhook:bg] Done: ${result.processed} processed, ${result.errors} errors`);
        } catch (err) {
          console.error("[Webhook:bg] Processing failed:", err);
        }
      })
    );

    return NextResponse.json({ received: true, queued: true, agent_id: agent.id, agent_type: agent.type });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// checkTargetingRules (roteador divergente: OR + fail-closed + case-sensitive)
// REMOVIDO 2026-06-17 — unificado em checkContactMatchesTargeting (failMode
// "closed"), que cobre tag/custom_field/pipeline_stage/MESSAGE + grupos E/OU
// com a MESMA semântica do gate de runtime. Ver src/lib/queue/targeting.ts.

/**
 * Verifica se é mensagem real (não evento interno do GHL)
 */
function isRealMessage(messageType: string, direction: string): boolean {
  const mt = (messageType || "").toUpperCase();

  const validTypes = [
    "SMS", "TYPE_CUSTOM_SMS", "WHATSAPP", "TYPE_WHATSAPP",
    "INSTAGRAM", "TYPE_INSTAGRAM", "IG", "TYPE_IG",
    "EMAIL", "TYPE_EMAIL", "FB", "TYPE_FB", "FACEBOOK", "TYPE_FACEBOOK",
    "LIVE_CHAT", "TYPE_LIVE_CHAT", "CUSTOM", "TYPE_CUSTOM", "GMB", "TYPE_GMB",
    // REACTION: rep curte com 👍✅ pra confirmar. Sparkbot mapeia pra "sim".
    // Adicionado explícito em validTypes pra não depender da regra fallback
    // "direction=inbound returns true" — defense in depth.
    "REACTION", "TYPE_REACTION",
  ];

  if (validTypes.includes(mt)) return true;

  const invalidTypes = [
    "TASKCREATE", "TASKDELETE", "TASKCOMPLETE",
    "NOTECREATE", "NOTEDELETE", "NOTEUPDATE",
    "OPPORTUNITYCREATE", "OPPORTUNITYDELETE", "OPPORTUNITYUPDATE",
    "OPPORTUNITYSTATUSUPDATE", "OPPORTUNITYASSIGNEDTOUPDATE",
    "OPPORTUNITYMONETARYVALUEUPDATE", "OPPORTUNITYSTAGEUPDATE",
    "CONTACTCREATE", "CONTACTDELETE", "CONTACTUPDATE", "CONTACTDNDUPDATE",
    "APPOINTMENTCREATE", "APPOINTMENTDELETE", "APPOINTMENTUPDATE",
    "USERCREATE",
  ];

  if (invalidTypes.includes(mt)) return false;
  if (direction === "inbound") return true;

  console.log(`[Webhook] Rejecting unknown type: "${messageType}"`);
  return false;
}

interface WorkingHoursDay { enabled: boolean; start: string; end: string; }
interface WorkingHours { enabled: boolean; timezone: string; mode: "only_during" | "only_outside"; schedule: Record<string, WorkingHoursDay>; }

function isWithinWorkingHours(wh: WorkingHours): boolean {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: wh.timezone || "America/New_York",
    weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase() || "";
  const hour = parts.find((p) => p.type === "hour")?.value || "0";
  const minute = parts.find((p) => p.type === "minute")?.value || "0";
  const currentMinutes = parseInt(hour) * 60 + parseInt(minute);

  const dayConfig = wh.schedule[weekday];
  if (!dayConfig || !dayConfig.enabled) return wh.mode === "only_outside";

  const [startH, startM] = dayConfig.start.split(":").map(Number);
  const [endH, endM] = dayConfig.end.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  // Janela noturna (start>end, ex: 22h–6h) "dá a volta" na meia-noite.
  // Fix ultra-review 2026-05-26: antes start>end nunca era "dentro" → agente mudo.
  const isDuringHours =
    startMin <= endMin
      ? currentMinutes >= startMin && currentMinutes <= endMin
      : currentMinutes >= startMin || currentMinutes <= endMin;

  return wh.mode === "only_during" ? isDuringHours : !isDuringHours;
}

/**
 * Calcula próximo timestamp ISO em que estaremos dentro de working hours
 * (no tz da location). Usado pra enfileirar msgs recebidas fora do expediente
 * com process_after = next_work_window_start, em vez de dropar silenciosamente.
 *
 * Fix HIGH-13 (deep review 2026-05-05): antes, msg fora do expediente era
 * skipped sem persistir nada → lead nunca recebia resposta. Agora enfileira
 * pro próximo expediente. Cap em 7 dias pra evitar runaway se schedule é
 * inconsistente (ex: todos dias disabled).
 *
 * Returns null se não conseguir achar janela em 7 dias.
 */
function nextWorkingHourStart(wh: WorkingHours): string | null {
  const tz = wh.timezone || "America/New_York";
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const target = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(target);
    const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase() || "";
    const dayConfig = wh.schedule[weekday];
    if (!dayConfig || !dayConfig.enabled) continue;
    if (dayNames.indexOf(weekday) < 0) continue;

    const [startH, startM] = dayConfig.start.split(":").map(Number);
    const [endH, endM] = dayConfig.end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    const dayHour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");
    const dayMinute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
    const dayCurrentMinutes = dayOffset === 0 ? dayHour * 60 + dayMinute : 0;

    // Se ainda não passou da janela hoje, agenda pra start ou agora (o que for maior)
    if (dayCurrentMinutes < endMinutes) {
      const targetMinutes = Math.max(startMinutes, dayCurrentMinutes);
      const yyyy = parts.find((p) => p.type === "year")?.value || "";
      const mm = parts.find((p) => p.type === "month")?.value || "";
      const dd = parts.find((p) => p.type === "day")?.value || "";
      // Constrói ISO no tz e converte pra UTC. Não preciso de precisão DST
      // pra esse caso — usar Date.parse com tz hint é suficiente.
      const targetDate = new Date(`${yyyy}-${mm}-${dd}T${String(Math.floor(targetMinutes / 60)).padStart(2, "0")}:${String(targetMinutes % 60).padStart(2, "0")}:00`);
      // Ajusta pra tz: comparar offset entre tz e local
      const tzOffset = (() => {
        const tzFmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tz, hour12: false,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
        });
        const sample = new Date(targetDate.getTime());
        const sampleParts = tzFmt.formatToParts(sample);
        const get = (t: string) => parseInt(sampleParts.find((p) => p.type === t)?.value || "0");
        return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - sample.getTime();
      })();
      return new Date(targetDate.getTime() - tzOffset).toISOString();
    }
  }
  return null;
}

/**
 * Verifica se alguma regra de desligamento foi acionada.
 * Retorna true se a IA deve ser desligada para este contato.
 */
async function checkDeactivationRules(
  rules: { type: string; tag?: string; field_key?: string; field_value?: string }[],
  contactId: string,
  companyId: string,
  locationId: string
): Promise<boolean> {
  if (rules.length === 0) return false;

  try {
    const client = new GHLClient(companyId, locationId);
    const contact = await client.get<{
      contact: {
        tags: string[];
        customFields: { id: string; value: string; fieldKey?: string }[];
      };
    }>(`/contacts/${contactId}`);

    const contactData = contact.contact;
    if (!contactData) return false;

    for (const rule of rules) {
      switch (rule.type) {
        case "tag_added":
          // Desligar se o contato TEM esta tag
          if (rule.tag && contactData.tags?.includes(rule.tag)) {
            console.log(`[Deactivation] Contact ${contactId} has tag "${rule.tag}", deactivating`);
            return true;
          }
          break;

        case "tag_removed":
          // Desligar se o contato NAO TEM esta tag
          if (rule.tag && !contactData.tags?.includes(rule.tag)) {
            console.log(`[Deactivation] Contact ${contactId} missing tag "${rule.tag}", deactivating`);
            return true;
          }
          break;

        case "custom_field_equals":
          if (rule.field_key) {
            const field = contactData.customFields?.find(
              (f) => f.id === rule.field_key || f.fieldKey === rule.field_key
            );
            if (field && field.value === rule.field_value) {
              console.log(`[Deactivation] Contact ${contactId} field ${rule.field_key}=${rule.field_value}, deactivating`);
              return true;
            }
          }
          break;
      }
    }

    return false;
  } catch (error) {
    console.error("[Deactivation] Error checking rules:", error);
    return false; // Em caso de erro, não desligar (fail open)
  }
}
