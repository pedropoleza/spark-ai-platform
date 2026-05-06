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

/**
 * Opt-in check: rep só pode receber proativo se INICIOU conversa pelo menos
 * 1x via WhatsApp (last_inbound_at IS NOT NULL).
 *
 * Fix CRITICAL bug 2026-05-06: setup wizard auto-aceita terms quando admin
 * ativa o agent, mas isso NÃO significa que o rep deu opt-in via WhatsApp.
 * Enviar proativo pra rep "terms-aceito-mas-nunca-mandou-msg" = pattern
 * spammer que Meta detecta → ban garantido do número Stevo.
 *
 * Defense in depth: tanto getEligibleReps no cron filtra, quanto aqui no
 * delivery rejeitamos pre-send (caso algum caller bypassa o filter do cron,
 * ex: chamada manual ou path proativo novo).
 */
function hasOptedInViaWhatsApp(rep: { last_inbound_at?: string | null }): boolean {
  return !!rep.last_inbound_at;
}

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
  rep: Pick<RepIdentity, "id" | "phone"> & { last_inbound_at?: string | null },
  formattedMessage: string,
  opts: DeliveryOptions,
): Promise<DeliveryResult> {
  const supabase = createAdminClient();

  // Fix CRITICAL bug 2026-05-06: opt-in gate. Sem inbound prévio do rep,
  // proativo PROIBIDO via WhatsApp/Stevo (ban risk). Cai pra channel='system'
  // (badge no painel web) — quando rep abrir painel e mandar 1ª msg, libera
  // proativos futuros normalmente.
  // Lookup last_inbound_at se rep não trouxe (defense in depth: caller pode
  // ter passado objeto Pick<> incompleto).
  let hasOptIn = hasOptedInViaWhatsApp(rep);
  if (!hasOptIn && rep.last_inbound_at === undefined) {
    // Re-fetch do DB pra confirmar
    const { data: full } = await supabase
      .from("rep_identities")
      .select("last_inbound_at")
      .eq("id", rep.id)
      .maybeSingle();
    if (full?.last_inbound_at) hasOptIn = true;
  }
  if (!hasOptIn) {
    console.warn(
      `[proactive-delivery] rep ${rep.id} sem last_inbound_at — opt-in WhatsApp ` +
        `não confirmado. SKIP send pra void; persistindo no painel web.`,
    );
    // Não envia via Stevo. Persiste como 'system' (badge web). Quando rep
    // mandar 1ª msg, próximos proativos serão entregues normalmente.
    const envHubLocationId =
      process.env.ASSISTANT_HUB_LOCATION_ID?.trim() || opts.activeLocationId;
    const { data: hubAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("location_id", envHubLocationId)
      .eq("type", "account_assistant")
      .eq("status", "active")
      .maybeSingle();
    if (!hubAgent) {
      // Sem hub não dá nem pra persistir — log + sai
      console.warn(
        `[proactive-delivery] hub agent não encontrado pra persistir como system (rep ${rep.id})`,
      );
      return { ok: false, via: "system", error: "no_hub_agent_no_optin" };
    }
    await supabase.from("sparkbot_messages").insert({
      rep_id: rep.id,
      hub_location_id: envHubLocationId,
      agent_id: hubAgent.id,
      active_location_id: opts.activeLocationId,
      role: "agent",
      content: formattedMessage,
      channel: "system",
      read_in_web_at: null, // badge ativo
      metadata: {
        source: opts.source,
        ...(opts.reminderId ? { reminder_id: opts.reminderId } : {}),
        ...(opts.kind ? { task_type: opts.kind } : {}),
        whatsapp_sent: false,
        delivery_status: "blocked_no_optin",
        block_reason: "rep sem last_inbound_at — proativo bloqueado pra evitar ban Meta",
        ...opts.extraMetadata,
      },
    });
    return { ok: true, via: "system", error: "blocked_no_optin", hubLocationId: envHubLocationId };
  }

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
  let ghlMessageId: string | null = null;
  let ghlConversationId: string | null = null;

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

      // Envia via canal preferido (SMS via Stevo agora; WhatsApp futuro).
      // Fix bug observado em prod 2026-05-06: capturar messageId + conversationId
      // do response GHL pra rastrear delivery status real depois (polling
      // backfill em delivery-status-poller.ts). Antes, sem ID guardado,
      // status=failed no Stevo era invisível — bot achava que enviou,
      // mensagem morria silenciosamente.
      type SendResp = {
        messageId?: string;
        conversationId?: string;
        msg?: { id?: string };
        id?: string;
      };
      const { pickOutboundChannel, fallbackChannel } = await import(
        "../outbound-channel"
      );
      const outboundType = pickOutboundChannel();
      let sendResp: SendResp | undefined;
      try {
        sendResp = await ghlClient.post<SendResp>("/conversations/messages", {
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
        sendResp = await ghlClient.post<SendResp>("/conversations/messages", {
          type: fb,
          contactId,
          message: formattedMessage,
        });
      }
      ghlMessageId =
        sendResp?.messageId || sendResp?.msg?.id || sendResp?.id || null;
      ghlConversationId = sendResp?.conversationId || null;
      sentViaWhatsapp = true;

      // Imediato pós-send: GHL/Stevo mostra status final em ~1-3s pra
      // erros de instância inativa. Pollar 1x rapidamente pra detectar
      // failed cedo e marcar fallback web (rep vê no painel imediato).
      // Polling longo (delayed delivery) fica pro cron backfill.
      if (ghlMessageId) {
        try {
          await new Promise((r) => setTimeout(r, 2_500));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const detail = await ghlClient.get<any>(
            `/conversations/messages/${encodeURIComponent(ghlMessageId)}`,
          );
          const status = detail?.message?.status as string | undefined;
          const errMsg = detail?.message?.error as string | undefined;
          if (status && ["failed", "rejected"].includes(status.toLowerCase())) {
            sentViaWhatsapp = false;
            sendError = `delivery_failed (${status})${errMsg ? `: ${errMsg}` : ""}`;
            console.warn(
              `[proactive-delivery] msg ${ghlMessageId} virou ${status} — ` +
                `fallback pro painel web. err="${errMsg || "?"}"`,
            );
            // Auto-signal admin sobre Stevo down (rate-limited via
            // fingerprint dedup natural do recordSignal).
            try {
              const { recordSignalAsync } = await import(
                "@/lib/admin-signals/recorder"
              );
              recordSignalAsync({
                type: "failure",
                title: `Stevo delivery failed: ${errMsg || "unknown"}`,
                description:
                  `Mensagem proativa ${ghlMessageId} para rep ${rep.id} ` +
                  `falhou imediatamente após send. error="${errMsg}"\n` +
                  `provider_id=${detail?.message?.conversationProviderId}\n` +
                  `Verificar instância Stevo do HUB ${hubLocationId} (re-escanear QR?).`,
                severity: "high",
                source: "bot_auto",
                metadata: {
                  rep_id: rep.id,
                  hub_location_id: hubLocationId,
                  ghl_message_id: ghlMessageId,
                  stevo_error: errMsg,
                  stevo_provider_id:
                    detail?.message?.conversationProviderId || null,
                },
              });
            } catch {
              // Signal não-crítico — não bloqueia
            }
          }
        } catch (pollErr) {
          // Poll falhou — não é fatal. Backfill cron tenta de novo depois.
          console.warn(
            `[proactive-delivery] poll status pós-send falhou (não-fatal):`,
            pollErr instanceof Error ? pollErr.message : pollErr,
          );
        }
      }
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
  //
  // Fix bug observado em prod 2026-05-06: salvar ghl_message_id +
  // ghl_conversation_id pra polling backfill verificar status real depois.
  // delivery_status segue tracking pós-poll: "pending" (acabou de enviar,
  // sem confirmação), "delivered", "failed". Backfill cron atualiza depois.
  await supabase.from("sparkbot_messages").insert({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: hubAgent.id,
    active_location_id: opts.activeLocationId,
    role: "agent",
    content: formattedMessage,
    channel: sentViaWhatsapp ? "whatsapp" : "system",
    ghl_message_id: ghlMessageId,
    read_in_web_at: sentViaWhatsapp ? new Date().toISOString() : null,
    metadata: {
      source: opts.source,
      ...(opts.reminderId ? { reminder_id: opts.reminderId } : {}),
      ...(opts.kind ? { task_type: opts.kind } : {}),
      whatsapp_sent: sentViaWhatsapp,
      whatsapp_send_error: sendError,
      whatsapp_delivery_enabled: enabled,
      ghl_message_id: ghlMessageId,
      ghl_conversation_id: ghlConversationId,
      delivery_status: sentViaWhatsapp ? "pending_confirm" : "failed_immediate",
      delivery_status_checked_at: null,
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
