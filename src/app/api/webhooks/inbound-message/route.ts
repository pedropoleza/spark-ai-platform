import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
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

    // ===== VALIDAÇÃO: Campos obrigatórios =====
    if (!locationId || !contactId || !messageBody) {
      return NextResponse.json({ received: true, skipped: "missing_fields" });
    }

    // Validar formato dos IDs (alfanumérico)
    if (!/^[a-zA-Z0-9]{5,50}$/.test(locationId) || !/^[a-zA-Z0-9]{5,50}$/.test(contactId)) {
      return NextResponse.json({ received: true, skipped: "invalid_ids" });
    }

    if (direction === "outbound") {
      return NextResponse.json({ received: true, skipped: "outbound" });
    }

    const channel = detectChannel(messageType, (body.customData as Record<string, unknown>)?.channel as string | undefined);
    const supabase = createAdminClient();

    // ===== BUSCAR AGENTE ATIVO (sales ou recruitment) =====
    const { data: agents } = await supabase
      .from("agents")
      .select("id, type, location_id, agent_configs(debounce_seconds, targeting_rules, enabled_channels, deactivation_rules)")
      .eq("location_id", locationId)
      .eq("status", "active")
      .in("type", ["sales_agent", "recruitment_agent"])
      .limit(1);

    const agent = agents?.[0];
    if (!agent) {
      return NextResponse.json({ received: true, skipped: "no_active_agent" });
    }

    const config = Array.isArray(agent.agent_configs)
      ? agent.agent_configs[0]
      : agent.agent_configs;

    const debounceSeconds = config?.debounce_seconds || 15;
    const targetingRules: TargetingRule[] = config?.targeting_rules || [];
    const enabledChannels: string[] = config?.enabled_channels || ["SMS", "WhatsApp"];

    // ===== FILTRO: Canal habilitado =====
    if (!enabledChannels.includes(channel)) {
      return NextResponse.json({ received: true, skipped: "channel_not_enabled" });
    }

    // ===== FILTRO: Targeting rules (FAIL CLOSED) =====
    if (targetingRules.length > 0) {
      const { data: location } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", locationId)
        .single();

      if (!location) {
        return NextResponse.json({ received: true, skipped: "location_not_found" });
      }

      const matches = await checkTargetingRules(
        targetingRules, contactId, location.company_id, locationId
      );

      // FAIL CLOSED: se não conseguiu verificar ou não bateu, rejeitar
      if (!matches) {
        return NextResponse.json({ received: true, skipped: "targeting_not_matched" });
      }

      // ===== FILTRO: Regras de desligamento =====
      const deactivationRules = config?.deactivation_rules || [];
      if (deactivationRules.length > 0) {
        const shouldDeactivate = await checkDeactivationRules(
          deactivationRules, contactId, location.company_id, locationId
        );
        if (shouldDeactivate) {
          return NextResponse.json({ received: true, skipped: "deactivated_by_rule" });
        }
      }
    }

    // ===== FILTRO: Working hours =====
    const { data: workingHoursConfig } = await supabase
      .from("agent_configs")
      .select("working_hours")
      .eq("agent_id", agent.id)
      .single();

    if (workingHoursConfig?.working_hours) {
      const wh = workingHoursConfig.working_hours;
      if (wh.enabled && !isWithinWorkingHours(wh)) {
        return NextResponse.json({ received: true, skipped: "outside_working_hours" });
      }
    }

    // ===== DEBOUNCE ATÔMICO: usar RPC ou transação =====
    const processAfter = new Date(Date.now() + debounceSeconds * 1000).toISOString();
    const now = new Date().toISOString();

    // Atualizar pendentes + inserir nova em uma sequência atômica
    // Primeiro inserir a mensagem
    const { error: insertError } = await supabase.from("message_queue").insert({
      location_id: locationId,
      contact_id: contactId,
      conversation_id: conversationId || "",
      message_body: messageBody,
      message_type: messageType,
      message_direction: direction,
      channel: channel,
      ghl_message_id: (body.id as string) || null,
      received_at: now,
      process_after: processAfter,
      status: "pending",
    });

    if (insertError) {
      console.error("Erro ao inserir na fila:", insertError);
      return NextResponse.json({ error: "queue_insert_failed" }, { status: 500 });
    }

    // Depois empurrar TODAS as pendentes (incluindo a que acabou de inserir)
    await supabase
      .from("message_queue")
      .update({ process_after: processAfter })
      .eq("location_id", locationId)
      .eq("contact_id", contactId)
      .eq("status", "pending");

    return NextResponse.json({ received: true, queued: true });
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
