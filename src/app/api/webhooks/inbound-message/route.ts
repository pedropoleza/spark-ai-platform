import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { extractAudioUrl } from "@/lib/ai/audio-transcriber";
import type { TargetingRule } from "@/types/agent";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    // ===== SEGURANÇA: Validar origem =====
    // Se GHL_WEBHOOK_SECRET estiver configurado, verificar assinatura
    const webhookSecret = process.env.GHL_WEBHOOK_SECRET;
    if (webhookSecret) {
      // GHL envia assinatura no header (verificar formato exato da GHL)
      const signature = request.headers.get("x-ghl-signature") ||
        request.headers.get("x-signature") ||
        request.headers.get("x-webhook-signature");

      if (!signature) {
        return NextResponse.json({ error: "missing_signature" }, { status: 401 });
      }

      // Verificar via HMAC (importar crypto nativo do Node)
      const { createHmac } = await import("crypto");
      const expectedSig = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

      if (signature !== expectedSig) {
        console.warn("[Webhook] Invalid signature");
        return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
      }
    }

    // ===== PARSING =====
    const locationId = (body.locationId || body.location_id) as string | undefined;
    const contactId = (body.contactId || body.contact_id || (body.customData as Record<string, unknown>)?.contact_id) as string | undefined;
    const conversationId = (body.conversationId || body.conversation_id) as string | undefined;
    const messageBody = (body.body || body.message || (body.customData as Record<string, unknown>)?.message) as string | undefined;
    const messageType = (body.messageType || body.type || "SMS") as string;
    const direction = (body.direction || "inbound") as string;

    // ===== FILTRO: Apenas mensagens reais =====
    if (!isRealMessage(messageType, direction)) {
      return NextResponse.json({ received: true, skipped: "not_a_real_message" });
    }

    // ===== AUDIO: Extrair URL se for mensagem de voz =====
    const audioInfo = extractAudioUrl(body);
    const audioUrl = audioInfo?.url || null;
    const audioMimeType = audioInfo?.mimeType || null;

    // ===== VALIDAÇÃO: Campos obrigatórios =====
    // Audio sem texto é valido (sera transcrito no processor)
    if (!locationId || !contactId || (!messageBody && !audioUrl)) {
      return NextResponse.json({ received: true, skipped: "missing_fields" });
    }

    // Validar formato dos IDs (alfanumérico)
    if (!/^[a-zA-Z0-9]{5,50}$/.test(locationId) || !/^[a-zA-Z0-9]{5,50}$/.test(contactId)) {
      return NextResponse.json({ received: true, skipped: "invalid_ids" });
    }

    if (direction === "outbound") {
      // Detectar handoff manual.
      // Duas formas de pausar a IA quando o humano envia mensagem:
      //   1) auto_pause_on_human_message = true  -> pausa em QUALQUER mensagem manual
      //   2) handoff_messages com auto_deactivate -> pausa apenas se bater o texto exato
      //
      // IMPORTANTE: ignorar mensagens enviadas pela propria IA. A IA
      // grava uma fingerprint na execution_log com o texto/contact_id
      // imediatamente antes de chamar o GHL, e checamos isso aqui.
      //
      // ROTA: se houver conversation_state para este contato, pausamos
      // exatamente aquele agente. Sales e recrutamento sao totalmente
      // separados e nao compartilham conversation_state.
      try {
        const supabaseAdmin = createAdminClient();

        // 1) Tenta resolver o agente pelo conversation_state do contato
        const { data: existingStates } = await supabaseAdmin
          .from("conversation_state")
          .select("agent_id")
          .eq("location_id", locationId)
          .eq("contact_id", contactId);

        let outboundAgent: { id: string; agent_configs: unknown } | null = null;

        const stateAgentIds = (existingStates || []).map((r) => r.agent_id).filter(Boolean);
        if (stateAgentIds.length > 0) {
          const { data: picked } = await supabaseAdmin
            .from("agents")
            .select("id, agent_configs(handoff_messages, auto_pause_on_human_message)")
            .in("id", stateAgentIds)
            .eq("status", "active")
            .limit(1)
            .maybeSingle();
          if (picked) outboundAgent = picked as { id: string; agent_configs: unknown };
        }

        // 2) Fallback: nao tem state — aplica apenas se existir exatamente UM
        //    agente ativo na location (senao nao sabemos pra qual aplicar)
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
            id: string;
            label: string;
            text: string;
            auto_deactivate: boolean;
          }[];

          const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
          const bodyNorm = normalize(messageBody || "");

          // Heuristica anti-eco: a IA, ao mandar uma mensagem via GHL,
          // tambem dispara este mesmo webhook como outbound. Para nao
          // pausar a IA por causa da propria IA, checamos o execution_log
          // dos ultimos 90s buscando um send_message para este contato
          // cujo texto bate com o que chegou.
          let isFromAi = false;
          if (autoPauseEnabled) {
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

            if (aiResponses) {
              for (const row of aiResponses) {
                const payload = (row.action_payload || {}) as { message?: unknown };
                const msg = payload.message;
                const candidates: string[] = Array.isArray(msg)
                  ? msg.filter((m): m is string => typeof m === "string")
                  : typeof msg === "string"
                  ? [msg]
                  : [];
                if (candidates.some((c) => normalize(c) === bodyNorm)) {
                  isFromAi = true;
                  break;
                }
              }
            }
          }

          let pauseReason: string | null = null;

          if (autoPauseEnabled && !isFromAi) {
            pauseReason = "auto_pause:human_message";
          } else if (!autoPauseEnabled) {
            // Modo legado: match exato com handoff_messages
            const matched = handoffMessages.find(
              (m) => m.auto_deactivate && normalize(m.text) === bodyNorm
            );
            if (matched) pauseReason = `handoff_message:${matched.label}`;
          }

          if (pauseReason) {
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
      return NextResponse.json({ received: true, skipped: "no_active_agent" });
    }

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
      return NextResponse.json({ received: true, skipped: "no_agent_matched_targeting" });
    }

    const agent = selectedAgent;
    const config = Array.isArray(agent.agent_configs)
      ? agent.agent_configs[0]
      : agent.agent_configs;

    const debounceSeconds = config?.debounce_seconds || 15;
    const enabledChannels: string[] = config?.enabled_channels || ["SMS", "WhatsApp"];

    // ===== FILTRO: Canal habilitado =====
    if (!enabledChannels.includes(channel)) {
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
    const wh = config?.working_hours;
    if (wh?.enabled && !isWithinWorkingHours(wh)) {
      return NextResponse.json({ received: true, skipped: "outside_working_hours" });
    }

    // ===== DEBOUNCE ATÔMICO: usar RPC ou transação =====
    const processAfter = new Date(Date.now() + debounceSeconds * 1000).toISOString();
    const now = new Date().toISOString();

    // Atualizar pendentes + inserir nova em uma sequência atômica
    // Primeiro inserir a mensagem (com agent_id explicito — crucial para
    // evitar cross-contamination no processor)
    const { error: insertError } = await supabase.from("message_queue").insert({
      agent_id: agent.id,
      location_id: locationId,
      contact_id: contactId,
      conversation_id: conversationId || "",
      message_body: messageBody || "[audio]",
      message_type: messageType,
      message_direction: direction,
      channel: channel,
      ghl_message_id: (body.id as string) || null,
      audio_url: audioUrl,
      audio_mime_type: audioMimeType,
      received_at: now,
      process_after: processAfter,
      status: "pending",
    });

    if (insertError) {
      console.error("Erro ao inserir na fila:", insertError);
      return NextResponse.json({ error: "queue_insert_failed" }, { status: 500 });
    }

    // Depois empurrar TODAS as pendentes do MESMO agente + contato
    await supabase
      .from("message_queue")
      .update({ process_after: processAfter })
      .eq("agent_id", agent.id)
      .eq("contact_id", contactId)
      .eq("status", "pending");

    return NextResponse.json({ received: true, queued: true, agent_id: agent.id, agent_type: agent.type });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
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
