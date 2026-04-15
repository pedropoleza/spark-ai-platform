/**
 * Motor de reacoes a dados coletados.
 *
 * Apos a IA responder, o processor chama este modulo com:
 *   - automations do agente
 *   - collected_data anterior
 *   - collected_data novo
 *   - ids de reacoes ja disparadas para este contato
 *
 * O motor identifica quais regras `on_data_field_set` devem disparar
 * (campo que mudou + operator bate) e executa as acoes correspondentes,
 * sem re-disparar reacoes ja registradas na conversation_state.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import type { AutomationRule, AutomationAction } from "@/types/agent";

const BUCKET = "agent-media";

interface ReactionContext {
  agentId: string;
  locationId: string;
  companyId: string;
  contactId: string;
  conversationId: string;
  channel?: string;
}

function channelToMessageType(channel?: string): string {
  switch (channel) {
    case "WhatsApp": return "WhatsApp";
    case "Instagram": return "IG";
    case "Email": return "Email";
    default: return "SMS";
  }
}

function fieldChanged(
  prev: Record<string, string>,
  next: Record<string, string>,
  key: string
): { changed: boolean; value: string | null } {
  const before = prev[key];
  const after = next[key];
  if (before === after) return { changed: false, value: after ?? null };
  return { changed: true, value: after ?? null };
}

function matchesOperator(
  operator: "any_value" | "equals" | "contains" | "matches_regex",
  actual: string | null,
  expected: string | undefined
): boolean {
  if (actual === null || actual === undefined || actual === "") return false;
  switch (operator) {
    case "any_value":
      return true;
    case "equals":
      return !!expected && actual.trim().toLowerCase() === expected.trim().toLowerCase();
    case "contains":
      return !!expected && actual.toLowerCase().includes(expected.toLowerCase());
    case "matches_regex":
      if (!expected) return false;
      try {
        return new RegExp(expected, "i").test(actual);
      } catch {
        return false;
      }
  }
}

/**
 * Decide quais regras de `on_data_field_set` devem disparar agora.
 * Retorna apenas regras NAO presentes em `alreadyTriggered`.
 */
export function pickTriggeredDataFieldRules(
  rules: AutomationRule[],
  prev: Record<string, string>,
  next: Record<string, string>,
  alreadyTriggered: Set<string>
): AutomationRule[] {
  const fired: AutomationRule[] = [];
  for (const rule of rules) {
    if (alreadyTriggered.has(rule.id)) continue;
    const trig = rule.trigger;
    if (!trig || trig.kind !== "on_data_field_set") continue;

    const { changed, value } = fieldChanged(prev, next, trig.field_key);
    if (!changed) continue;
    if (!matchesOperator(trig.operator, value, trig.value)) continue;

    fired.push(rule);
  }
  return fired;
}

/**
 * Executa as acoes de uma lista de regras. Cada acao eh resiliente a
 * falha isolada (uma acao falha nao aborta as outras).
 */
export async function executeReactionRules(
  rules: AutomationRule[],
  ctx: ReactionContext
): Promise<{ executedRuleIds: string[] }> {
  const supabase = createAdminClient();
  const client = new GHLClient(ctx.companyId, ctx.locationId);
  const messageType = channelToMessageType(ctx.channel);
  const executed: string[] = [];

  for (const rule of rules) {
    let ruleOk = true;
    for (const action of rule.actions) {
      try {
        await executeOne(action, ctx, client, supabase, messageType);
      } catch (error) {
        ruleOk = false;
        await supabase.from("execution_log").insert({
          agent_id: ctx.agentId,
          location_id: ctx.locationId,
          contact_id: ctx.contactId,
          conversation_id: ctx.conversationId,
          action_type: `reaction_${action.type}`,
          action_payload: { rule_id: rule.id, action },
          success: false,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (ruleOk) executed.push(rule.id);
  }

  return { executedRuleIds: executed };
}

async function executeOne(
  action: AutomationAction,
  ctx: ReactionContext,
  client: GHLClient,
  supabase: ReturnType<typeof createAdminClient>,
  messageType: string
): Promise<void> {
  switch (action.type) {
    case "add_tag": {
      if (!action.tag) return;
      await client.post(`/contacts/${ctx.contactId}/tags`, { tags: [action.tag] });
      break;
    }
    case "remove_tag": {
      if (!action.tag) return;
      await client.delete(`/contacts/${ctx.contactId}/tags`, { tags: [action.tag] });
      break;
    }
    case "move_pipeline": {
      if (!action.pipeline_id || !action.stage_id) return;
      await client.put(`/opportunities/`, {
        pipelineId: action.pipeline_id,
        pipelineStageId: action.stage_id,
        contactId: ctx.contactId,
        locationId: ctx.locationId,
      });
      break;
    }
    case "update_field": {
      if (!action.field_key) return;
      if (action.field_key.startsWith("contact.")) {
        const fieldName = action.field_key.replace("contact.", "");
        await client.put(`/contacts/${ctx.contactId}`, { [fieldName]: action.field_value || "" });
      } else {
        await client.put(`/contacts/${ctx.contactId}`, {
          customFields: [{ id: action.field_key, value: action.field_value || "" }],
        });
      }
      break;
    }
    case "send_text_fixed": {
      if (!action.text || !action.text.trim()) return;
      await client.post("/conversations/messages", {
        type: messageType,
        contactId: ctx.contactId,
        message: action.text,
      });
      break;
    }
    case "send_media": {
      if (!action.media_id) return;
      const { data: media } = await supabase
        .from("media_library")
        .select("storage_path, mime_type, name")
        .eq("id", action.media_id)
        .eq("agent_id", ctx.agentId)
        .single();

      if (!media) throw new Error(`Midia ${action.media_id} nao encontrada`);

      // URL assinada com TTL de 10 minutos
      const { data: signed, error: signError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(media.storage_path, 600);

      if (signError || !signed?.signedUrl) {
        throw new Error(`Falha ao gerar URL assinada: ${signError?.message || "unknown"}`);
      }

      // GHL aceita attachments como array de URLs em /conversations/messages.
      // SMS puro nao suporta — o call passa o texto como caption.
      await client.post("/conversations/messages", {
        type: messageType,
        contactId: ctx.contactId,
        message: action.media_caption || "",
        attachments: [signed.signedUrl],
      });
      break;
    }
    case "pause_ai": {
      const nowIso = new Date().toISOString();
      await supabase
        .from("conversation_state")
        .upsert(
          {
            agent_id: ctx.agentId,
            location_id: ctx.locationId,
            contact_id: ctx.contactId,
            conversation_id: ctx.conversationId,
            status: "handed_off",
            ai_paused_at: nowIso,
            ai_paused_reason: `reaction:pause_ai${action.pause_minutes ? `:${action.pause_minutes}min` : ""}`,
            updated_at: nowIso,
          },
          { onConflict: "agent_id,contact_id" }
        );
      break;
    }
    case "webhook": {
      if (!action.webhook_url) return;
      await fetch(action.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: ctx.agentId,
          contact_id: ctx.contactId,
          location_id: ctx.locationId,
          triggered_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(8000),
      });
      break;
    }
  }
}
