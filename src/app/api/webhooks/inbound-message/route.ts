import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";

export const maxDuration = 60;
import { createAdminClient } from "@/lib/supabase/admin";

// ===== In-memory rate limiter =====
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // max 30 messages per contact per minute

function checkRateLimit(contactId: string): boolean {
  const now = Date.now();
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
import { processMessageQueue } from "@/lib/queue/processor";
import type { TargetingRule } from "@/types/agent";

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
      console.warn("[Webhook] ⚠️  No signature verification — GHL_WEBHOOK_SECRET not set");
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

    // Debug Pedro 2026-05-19 v3: grava body INTEIRO de qualquer inbound do
    // contato do Pedro (Hub) pra capturar shape do CSV via Stevo no ponto de
    // ENTRADA (antes de qualquer filtro/roteamento). REMOVER após fix.
    if (contactId === "61ZDGmCxZW0V2OODGcHo") {
      try {
        const fullBody: Record<string, unknown> = {};
        for (const k of Object.keys(body)) {
          const v = (body as Record<string, unknown>)[k];
          if (typeof v === "string") fullBody[k] = v.slice(0, 250);
          else if (Array.isArray(v)) fullBody[k] = `[arr ${v.length}] ${JSON.stringify(v).slice(0, 900)}`;
          else if (v && typeof v === "object") fullBody[k] = JSON.stringify(v).slice(0, 900);
          else fullBody[k] = v;
        }
        const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
        recordSignalAsync({
          type: "error",
          title: "DEBUG3: webhook raw Pedro",
          description: `type=${messageType} keys=[${Object.keys(body).join(",")}]`,
          severity: "low",
          source: "bot_auto",
          metadata: { full_body: fullBody, message_type: messageType },
        });
      } catch { /* nf */ }
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
    if (!locationId || !contactId || (!messageBody && !audioUrl && mediaAttachments.length === 0)) {
      console.log(`[Webhook] Skipped: missing_fields (loc=${locationId}, contact=${contactId}, body=${!!messageBody}, audio=${!!audioUrl})`);
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
          .in("type", ["sales_agent", "recruitment_agent"]);

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
      //   - source="api" ou sem userId = enviado via API (nossa IA)
      //   - source="workflow" = automação do GHL
      //
      // Combinamos source/userId com heurística anti-eco como fallback.
      const webhookSource = (body.source || "") as string;
      const webhookUserId = (body.userId || body.user_id || "") as string;
      const isFromGhlApp = webhookSource === "app" && !!webhookUserId;
      const isFromApi = webhookSource === "api" || webhookSource === "workflow";

      console.log(`[Webhook:outbound] contact=${contactId} | source="${webhookSource}" | userId="${webhookUserId}" | isApp=${isFromGhlApp} | body="${(messageBody || "").substring(0, 40)}"`);

      // Se source indica API/workflow, é nossa IA ou automação — ignorar
      if (isFromApi) {
        return NextResponse.json({ received: true, skipped: "outbound_api" });
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
            .in("type", ["sales_agent", "recruitment_agent"]);
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

          // Determinar se é mensagem humana:
          // 1) source="app" com userId → definitivamente humano
          // 2) source vazio/desconhecido → anti-eco como fallback
          let isHumanMessage = isFromGhlApp;

          if (!isHumanMessage && !isFromApi) {
            // Fallback anti-eco: checar se o texto bate com msg recente da IA
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

            const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
            const bodyNorm = normalize(messageBody || "");
            let matchedAi = false;

            if (aiResponses) {
              for (const row of aiResponses) {
                const payload = (row.action_payload || {}) as { message?: unknown };
                const msg = payload.message;
                const candidates: string[] = Array.isArray(msg)
                  ? msg.filter((m): m is string => typeof m === "string")
                  : typeof msg === "string" ? [msg] : [];
                if (candidates.some((c) => normalize(c) === bodyNorm)) {
                  matchedAi = true;
                  break;
                }
              }
            }

            // Se NÃO bateu com nenhuma msg da IA → é humano
            isHumanMessage = !matchedAi;
          }

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
      .in("type", ["sales_agent", "recruitment_agent"]);

    if (!allAgents || allAgents.length === 0) {
      console.log(`[Webhook] Skipped: no_active_agent for location ${locationId}`);
      return NextResponse.json({ received: true, skipped: "no_active_agent" });
    }
    console.log(`[Webhook] Found ${allAgents.length} active agent(s): ${allAgents.map(a => a.type).join(", ")}`);

    // 1) Agente ja dono da conversa
    const { data: existingStates } = await supabase
      .from("conversation_state")
      .select("agent_id")
      .eq("location_id", locationId)
      .eq("contact_id", contactId);

    const stateAgentIds = new Set((existingStates || []).map((r) => r.agent_id).filter(Boolean));

    type AgentRow = typeof allAgents[number];
    let selectedAgent: AgentRow | null = null;

    if (stateAgentIds.size > 0) {
      selectedAgent = allAgents.find((a) => stateAgentIds.has(a.id)) || null;
    }

    // Precisamos da location para checar targeting
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", locationId)
      .single();

    if (!location) {
      console.log(`[Webhook] Skipped: location_not_found (${locationId})`);
      return NextResponse.json({ received: true, skipped: "location_not_found" });
    }

    // 2) Rotear por targeting quando nao houver conversa anterior
    if (!selectedAgent) {
      for (const candidate of allAgents) {
        const cfg = Array.isArray(candidate.agent_configs)
          ? candidate.agent_configs[0]
          : candidate.agent_configs;
        const rules: TargetingRule[] = cfg?.targeting_rules || [];
        if (rules.length === 0) {
          // Agente sem targeting aceita qualquer contato — vira fallback
          if (!selectedAgent) selectedAgent = candidate;
          continue;
        }
        const matches = await checkTargetingRules(rules, contactId, location.company_id, locationId);
        if (matches) {
          selectedAgent = candidate;
          break;
        }
      }
    }

    if (!selectedAgent) {
      console.log(`[Webhook] Skipped: no_agent_matched_targeting for contact ${contactId}`);
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
      ghl_message_id: (body.id as string) || null,
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

/**
 * Verifica targeting rules. FAIL CLOSED: retorna false em caso de erro.
 */
async function checkTargetingRules(
  rules: TargetingRule[], contactId: string, companyId: string, locationId: string
): Promise<boolean> {
  try {
    const client = new GHLClient(companyId, locationId);
    const contact = await client.get<{
      contact: {
        id: string;
        tags: string[];
        customFields: { id: string; value: string; fieldKey?: string }[];
      };
    }>(`/contacts/${contactId}`);

    const contactData = contact.contact;
    if (!contactData) return false;

    for (const rule of rules) {
      switch (rule.type) {
        case "tag":
          if (rule.tag && contactData.tags?.includes(rule.tag)) return true;
          break;
        case "custom_field":
          if (rule.custom_field_key) {
            const field = contactData.customFields?.find(
              (f) => f.id === rule.custom_field_key || f.fieldKey === rule.custom_field_key
            );
            if (field && field.value === rule.custom_field_value) return true;
          }
          break;
        case "pipeline_stage":
          if (rule.pipeline_id && rule.pipeline_stage_id) {
            try {
              const opps = await client.get<{
                opportunities: { pipelineId: string; pipelineStageId: string }[];
              }>("/opportunities/search", {
                location_id: locationId, contact_id: contactId, pipeline_id: rule.pipeline_id,
              });
              if (opps.opportunities?.some(
                (o) => o.pipelineId === rule.pipeline_id && o.pipelineStageId === rule.pipeline_stage_id
              )) return true;
            } catch { /* skip this rule */ }
          }
          break;
      }
    }
    return false;
  } catch (error) {
    // FAIL CLOSED: se não conseguiu verificar, não processar
    console.error("[Webhook] Targeting check failed (BLOCKING):", error);
    return false;
  }
}

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

function detectChannel(messageType: string, customChannel?: string): string {
  if (customChannel) {
    const ch = customChannel.toLowerCase();
    if (ch.includes("whatsapp") || ch.includes("wa")) return "WhatsApp";
    if (ch.includes("instagram") || ch.includes("ig")) return "Instagram";
    if (ch.includes("email")) return "Email";
    if (ch.includes("sms")) return "SMS";
  }
  const mt = messageType?.toUpperCase() || "";
  if (mt.includes("WHATSAPP")) return "WhatsApp";
  if (mt.includes("INSTAGRAM") || mt === "TYPE_IG" || mt === "IG") return "Instagram";
  if (mt.includes("EMAIL")) return "Email";
  if (mt.includes("FB") || mt.includes("FACEBOOK")) return "Instagram";
  return "SMS";
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
  const isDuringHours = currentMinutes >= startH * 60 + startM && currentMinutes <= endH * 60 + endM;

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
