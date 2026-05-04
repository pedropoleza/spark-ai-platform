/**
 * Helper compartilhado pra entregar mensagens proativas (lembretes,
 * alertas de regras) via WhatsApp/SMS no Hub do rep.
 *
 * Extraído de reminder-runner.ts em 2026-05-04 pra ser reutilizado
 * pelo dispatcher.ts (modo 'real') quando regras proativas dispararem
 * (ex: post_meeting, deal_won, etc).
 *
 * Comportamento:
 *   1. Resolve hub_location_id (env override → último inbound do rep →
 *      ASSISTANT_HUB_LOCATION_ID env → activeLocationId fallback)
 *   2. Resolve agent_id do hub
 *   3. Se WHATSAPP_DELIVERY_ENABLED=1: search/create contact no hub pelo
 *      phone do rep, envia via outbound channel (SMS via Stevo agora)
 *   4. Insere registro em sparkbot_messages — channel='whatsapp' se
 *      enviou (read_in_web=now pra não badge no painel) ou 'system'
 *      (badge ativa) se WhatsApp falhou ou flag off
 *
 * Não aplica silence gate aqui — caller é responsável (dispatcher e
 * reminder-runner já fazem checkSilenceGate antes).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { RepIdentity } from "@/types/account-assistant";

export interface DeliveryOptions {
  /**
   * active_location_id da operação — vai em sparkbot_messages pra audit.
   * Pra reminders é task.location_id; pra regras proativas é o
   * active_location_id do rep.
   */
  activeLocationId: string;
  /**
   * Source de origem — vai em metadata.source.
   * Ex: 'scheduled_reminder', 'proactive_rule'.
   */
  source: string;
  /** task_id (lembretes) ou null. Vai em metadata.reminder_id. */
  reminderId?: string | null;
  /** Tipo do task/regra — vai em metadata.task_type. */
  kind?: string | null;
  /**
   * Metadata extra mergeada com defaults. Útil pra incluir rule_id,
   * appointment_id, etc.
   */
  extraMetadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  via: "whatsapp" | "system";
  /** Mensagem de erro do WhatsApp send (null se enviou ok ou flag off). */
  error?: string | null;
  /** hub_location_id resolvido (pra logs). */
  hubLocationId?: string;
}

/**
 * Entrega uma mensagem proativa (já formatada) pro rep.
 * Retorna sempre — se algo falhou, registra o erro mas não throw.
 */
export async function deliverProactiveMessage(
  rep: Pick<RepIdentity, "id" | "phone">,
  formattedMessage: string,
  opts: DeliveryOptions,
): Promise<DeliveryResult> {
  const supabase = createAdminClient();
  const envHubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  const hubCompanyId =
    process.env.ASSISTANT_HUB_COMPANY_ID?.trim() ||
    process.env.NEXT_PUBLIC_GHL_COMPANY_ID?.trim();

  // Hub resolution: env override → último inbound do rep → env single-hub
  // → activeLocationId fallback. Multi-hub: rep pode operar em hubs
  // diferentes, então o último inbound mostra qual hub está em uso.
  let repActualHub: string | null = null;
  const { data: lastInbound } = await supabase
    .from("sparkbot_messages")
    .select("hub_location_id")
    .eq("rep_id", rep.id)
    .eq("role", "user")
    .not("hub_location_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastInbound?.hub_location_id) {
    repActualHub = lastInbound.hub_location_id as string;
  }

  const hubLocationId =
    process.env.WHATSAPP_DELIVERY_LOCATION_ID?.trim() ||
    repActualHub ||
    envHubLocationId;

  if (!hubLocationId) {
    console.warn(`[proactive-delivery] hub não resolvido pra rep ${rep.id} (${opts.source})`);
    return { ok: false, via: "system", error: "no_hub_resolved" };
  }

  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  if (!hubAgent) {
    console.warn(
      `[proactive-delivery] hub agent não encontrado em ${hubLocationId} (${opts.source})`,
    );
    return { ok: false, via: "system", error: "no_hub_agent", hubLocationId };
  }

  const enabled = process.env.WHATSAPP_DELIVERY_ENABLED === "1";
  let sentViaWhatsapp = false;
  let sendError: string | null = null;

  // Tenta envio WhatsApp/SMS via Stevo se flag habilitada e rep tem phone real
  if (
    enabled &&
    hubCompanyId &&
    rep.phone &&
    !rep.phone.startsWith("webonly:")
  ) {
    try {
      const { GHLClient } = await import("@/lib/ghl/client");
      const ghlClient = new GHLClient(hubCompanyId, hubLocationId);

      // Busca contact_id do rep no hub pelo phone
      type ContactSearchResult = {
        contacts?: Array<{ id: string; phone?: string }>;
        results?: Array<{ id: string; phone?: string }>;
      };
      const search = await ghlClient
        .get<ContactSearchResult>("/contacts/search/duplicate", {
          locationId: hubLocationId,
          number: rep.phone,
        })
        .catch(() => null);

      let contactId = search?.contacts?.[0]?.id || search?.results?.[0]?.id;

      // Fallback: cria contact mínimo (pra ter onde enviar mensagem).
      // Quirk do Spark Leads (GHL): às vezes /search/duplicate não acha mas
      // /contacts/ devolve 400 com `meta.contactId` apontando pro existente.
      // Extraímos esse ID do erro em vez de explodir.
      if (!contactId) {
        try {
          const created = await ghlClient.post<{ contact: { id: string } }>(
            "/contacts/",
            {
              locationId: hubLocationId,
              phone: rep.phone,
              firstName: "Spark Rep",
              lastName: rep.id.slice(0, 8),
              tags: ["sparkbot-rep"],
            },
          );
          contactId = created.contact?.id;
        } catch (createErr) {
          const errMsg =
            createErr instanceof Error ? createErr.message : String(createErr);
          const jsonMatch = errMsg.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]) as {
                statusCode?: number;
                meta?: { contactId?: string };
              };
              if (parsed.statusCode === 400 && parsed.meta?.contactId) {
                contactId = parsed.meta.contactId;
                console.log(
                  `[proactive-delivery] contact existente extraído do erro 400: ${contactId}`,
                );
              }
            } catch {
              // JSON parse failed — segue pra throw
            }
          }
          if (!contactId) throw createErr;
        }
      }

      if (!contactId) {
        throw new Error("não consegui resolver contact_id no Spark Leads");
      }

      // Envia via canal preferido (SMS via Stevo agora; WhatsApp futuro)
      const { pickOutboundChannel, fallbackChannel } = await import(
        "../outbound-channel"
      );
      const outboundType = pickOutboundChannel();
      try {
        await ghlClient.post("/conversations/messages", {
          type: outboundType,
          contactId,
          message: formattedMessage,
        });
      } catch (sendErr) {
        const fb = fallbackChannel(outboundType);
        console.warn(
          `[proactive-delivery] send ${outboundType} falhou — fallback ${fb}:`,
          sendErr instanceof Error ? sendErr.message : sendErr,
        );
        await ghlClient.post("/conversations/messages", {
          type: fb,
          contactId,
          message: formattedMessage,
        });
      }
      sentViaWhatsapp = true;
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[proactive-delivery] WhatsApp falhou pra rep ${rep.id} (${opts.source}), ` +
          `fallback pro painel web: ${sendError}`,
      );
    }
  }

  // Sempre persiste em sparkbot_messages (mesmo se WhatsApp falhou —
  // assim rep não perde a mensagem; vê na próxima vez que abrir painel).
  // - sentViaWhatsapp=true → channel='whatsapp', read_in_web_at=now (sem badge)
  // - sentViaWhatsapp=false → channel='system' (badge ativa no painel)
  await supabase.from("sparkbot_messages").insert({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: hubAgent.id,
    active_location_id: opts.activeLocationId,
    role: "agent",
    content: formattedMessage,
    channel: sentViaWhatsapp ? "whatsapp" : "system",
    read_in_web_at: sentViaWhatsapp ? new Date().toISOString() : null,
    metadata: {
      source: opts.source,
      ...(opts.reminderId ? { reminder_id: opts.reminderId } : {}),
      ...(opts.kind ? { task_type: opts.kind } : {}),
      whatsapp_sent: sentViaWhatsapp,
      whatsapp_send_error: sendError,
      whatsapp_delivery_enabled: enabled,
      ...opts.extraMetadata,
    },
  });

  return {
    ok: true,
    via: sentViaWhatsapp ? "whatsapp" : "system",
    error: sendError,
    hubLocationId,
  };
}
