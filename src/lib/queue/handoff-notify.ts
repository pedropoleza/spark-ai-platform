/**
 * Handoff Notification via SparkBot — F37 (Pedro 2026-05-29).
 *
 * Quando o `should-respond` decide SKIP e flag notify_rep=true, esse módulo:
 *  1. Resolve o rep dono do contato (assignedTo do contato → fallback opp.assignedTo → fallback rep_identities da location)
 *  2. Confere idempotência (já notificou esse mesmo (rep, contato, reason) nas últimas 4h? Skip.)
 *  3. Formata msg natural pro rep
 *  4. Entrega via `deliverProactiveMessage` (Stevo/WhatsApp)
 *  5. Audita em `handoff_notifications` (se a tabela existir) + execution_log
 *
 * Idempotência defensiva: se a migration 00096 ainda não rodou,
 * `handoff_notifications` não existe — fallback usa execution_log com
 * action_type='handoff_notification' + filtro JSONB.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadContext, ShouldRespondDecision } from "@/types/agent";

const COOLDOWN_HOURS = 4;

interface NotifyArgs {
  agentId: string;
  locationId: string;
  contactId: string;
  decision: Extract<ShouldRespondDecision, { decision: "skip" }>;
  leadContext: LeadContext;
  currentInboundBody: string;
}

interface NotifyResult {
  notified: boolean;
  rep_id?: string;
  reason: string;
  skipped_reason?: "no_owner_resolved" | "cooldown" | "deliver_failed" | "policy_off";
}

interface RepRow {
  id: string;
  phone: string | null;
  active_location_id: string | null;
  ghl_users: Array<{ ghl_user_id?: string; location_id?: string }> | null;
}

/**
 * Tenta achar o rep dono do contato.
 * Cascata:
 *  1. `contact.assignedUserId` (GHL contact.assignedTo) → match em ghl_users.ghl_user_id
 *  2. `opportunities[].assignedTo` — primeira opp atribuída a um user (review 2026-06-05)
 *  3. Fallback: rep_identities com active_location_id == locationId E terms accepted E não-internal
 *
 * Retorna primeiro match. Se nada, null.
 */
async function resolveOwnerRep(
  supabase: ReturnType<typeof createAdminClient>,
  locationId: string,
  leadCtx: LeadContext,
): Promise<RepRow | null> {
  const assignedTo = leadCtx.contact.assignedUserId;

  // Tenta por ghl_user_id (JSONB array)
  if (assignedTo) {
    const { data: byOwner } = await supabase
      .from("rep_identities")
      .select("id, phone, active_location_id, ghl_users")
      .contains("ghl_users", [{ ghl_user_id: assignedTo }])
      .limit(1);
    if (byOwner && byOwner.length > 0) {
      return byOwner[0] as RepRow;
    }
  }

  // 2. opp.assignedTo (review 2026-06-05): se o contato não tem owner direto mas
  // tem uma opportunity atribuída a um user, usa esse user como dono. Antes ficava
  // "pra fase 2" e caía direto no fallback (notificava o rep ERRADO em location
  // multi-rep).
  const oppOwner = leadCtx.opportunities.find((o) => o.assignedTo)?.assignedTo;
  if (oppOwner && oppOwner !== assignedTo) {
    const { data: byOpp } = await supabase
      .from("rep_identities")
      .select("id, phone, active_location_id, ghl_users")
      .contains("ghl_users", [{ ghl_user_id: oppOwner }])
      .limit(1);
    if (byOpp && byOpp.length > 0) {
      return byOpp[0] as RepRow;
    }
  }

  // Fallback: qualquer rep da location com terms aceito + não internal
  const { data: anyRep } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, ghl_users")
    .eq("active_location_id", locationId)
    .eq("is_internal", false)
    .not("terms_accepted_at", "is", null)
    .is("proactive_paused_at", null)
    .limit(1);
  if (anyRep && anyRep.length > 0) {
    return anyRep[0] as RepRow;
  }

  return null;
}

/**
 * Idempotência: já notificou (location, contact, reason) nas últimas COOLDOWN_HOURS?
 */
async function alreadyNotified(
  supabase: ReturnType<typeof createAdminClient>,
  locationId: string,
  contactId: string,
  reason: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString();
  // Tenta na tabela dedicada primeiro
  try {
    const { count } = await supabase
      .from("handoff_notifications")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("contact_id", contactId)
      .eq("reason", reason)
      .gte("created_at", cutoff);
    if (typeof count === "number") return count > 0;
  } catch {
    // tabela ainda não existe (migration 00096 não rodou); cai pro fallback
  }
  // Fallback: execution_log
  const { count: c2 } = await supabase
    .from("execution_log")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId)
    .eq("contact_id", contactId)
    .eq("action_type", "handoff_notification")
    .gte("created_at", cutoff)
    .contains("action_payload", { reason });
  return (c2 ?? 0) > 0;
}

function formatRepNotification(
  leadCtx: LeadContext,
  currentInboundBody: string,
  decision: Extract<ShouldRespondDecision, { decision: "skip" }>,
): string {
  const name = leadCtx.contact.name || "lead";
  const phoneHint = leadCtx.contact.phone ? ` (${leadCtx.contact.phone})` : "";
  const reasonHuman = decision.reason.startsWith("human_replied_recently")
    ? "Você respondeu há pouco — não quero atropelar a conversa."
    : decision.reason.startsWith("lead_requested_human")
      ? "O lead pediu pra falar com você direto."
      : decision.reason.startsWith("opp_closed")
        ? "A oportunidade já está fechada."
        : "Achei melhor não responder.";
  const suggested = decision.suggested_action ? `\n\n${decision.suggested_action}` : "";
  const truncated = currentInboundBody.length > 280 ? currentInboundBody.slice(0, 280) + "…" : currentInboundBody;
  return (
    `📩 *${name}*${phoneHint} acabou de mandar:\n` +
    `"${truncated}"\n\n` +
    `${reasonHuman}${suggested}`
  );
}

/**
 * Notifica o rep responsável via SparkBot/WhatsApp.
 * NUNCA throw — sempre retorna NotifyResult com flag.
 */
export async function notifyRepViaSparkbot(args: NotifyArgs): Promise<NotifyResult> {
  const { agentId, locationId, contactId, decision, leadContext, currentInboundBody } = args;

  if (!decision.notify_rep) {
    return { notified: false, reason: decision.reason, skipped_reason: "policy_off" };
  }

  const supabase = createAdminClient();

  // 1. Resolve rep
  const rep = await resolveOwnerRep(supabase, locationId, leadContext);
  if (!rep) {
    return { notified: false, reason: decision.reason, skipped_reason: "no_owner_resolved" };
  }

  // 2. Idempotência
  if (await alreadyNotified(supabase, locationId, contactId, decision.reason)) {
    return { notified: false, reason: decision.reason, rep_id: rep.id, skipped_reason: "cooldown" };
  }

  // 3. Mensagem
  const message = formatRepNotification(leadContext, currentInboundBody, decision);

  // 4. Entrega via deliverProactiveMessage
  try {
    const { deliverProactiveMessage } = await import("@/lib/account-assistant/proactive/whatsapp-delivery");
    const deliveryResult = await deliverProactiveMessage(
      { id: rep.id, phone: rep.phone || "", last_inbound_at: null },
      message,
      {
        activeLocationId: rep.active_location_id || locationId,
        source: "lead_handoff_notification",
        kind: decision.reason.split(":")[0],
        extraMetadata: {
          handoff_reason: decision.reason,
          lead_contact_id: contactId,
          lead_name: leadContext.contact.name,
          agent_id: agentId,
        },
      },
    );

    // 5. Audit
    await supabase.from("execution_log").insert({
      agent_id: agentId,
      location_id: locationId,
      contact_id: contactId,
      action_type: "handoff_notification",
      action_payload: {
        rep_id: rep.id,
        reason: decision.reason,
        delivery_via: deliveryResult.via,
        delivery_ok: deliveryResult.ok,
      },
      success: deliveryResult.ok,
      error_message: deliveryResult.error || null,
    });

    // Tenta tbm em handoff_notifications (se existir)
    try {
      await supabase.from("handoff_notifications").insert({
        agent_id: agentId,
        location_id: locationId,
        contact_id: contactId,
        rep_id: rep.id,
        reason: decision.reason,
        trigger_message: currentInboundBody.slice(0, 1000),
        metadata: { delivery_via: deliveryResult.via },
      });
    } catch {
      // tabela ainda não existe — execution_log já cobre audit
    }

    return {
      notified: deliveryResult.ok,
      rep_id: rep.id,
      reason: decision.reason,
      skipped_reason: deliveryResult.ok ? undefined : "deliver_failed",
    };
  } catch (err) {
    console.warn(
      `[handoff-notify] delivery falhou (não-bloqueante): ${err instanceof Error ? err.message.slice(0, 200) : err}`,
    );
    return { notified: false, reason: decision.reason, rep_id: rep.id, skipped_reason: "deliver_failed" };
  }
}
