/**
 * Trigger "agente ativado pro contato" (H62, Pedro 2026-08-03).
 *
 * O admin monta a regra na Cat Automações do /hub (trigger `agent_activated`);
 * as ações (tag / mover no funil / atualizar campo / etc) rodam quando o agente
 * ASSUME o contato:
 *   (a) automático — 1º turno processado deste agente pro contato (a regra de
 *       ativação/targeting deixou passar). Ramo 11c do queue-processor, que
 *       reusa o bloco de reações existente (mesmo dedup, mesmo executor).
 *   (b) manual — alguém ligou o agente pro contato na UI (contact-pause resume
 *       / contact-activate). As rotas chamam `runAgentActivatedAutomations`.
 *
 * Dedup: 1× por (agente, contato) via rule.id em
 * `conversation_state.triggered_automations` — a MESMA lista dos ramos 11a/11b
 * (00014), então manual e automático não disparam em dobro. O merge não é CAS
 * (mesmo trade-off dos ramos existentes): corrida manual×turno na janela de ms
 * pode duplicar, e as ações do caso de uso são idempotentes no Spark Leads.
 *
 * Fail-soft SEMPRE: automação é cortesia — erro aqui nunca pode quebrar a rota
 * de ativação nem o turno do lead.
 *
 * Review H62 (2026-08-03): o dedup persiste DEPOIS de executar (mesmo trade-off
 * dos ramos 11a/11b — lambda morta no meio pode re-executar no próximo resume;
 * o inverso, persistir antes, perderia ações em falha transiente, pior pro caso
 * de uso). O runner REVALIDA agente↔location (não confia no caller) e resolve o
 * channel da conversa pelo último message_queue (send_text/media saem no canal
 * certo, não SMS cego).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutomationRule } from "@/types/agent";

/** Filtra as regras `agent_activated` ainda não disparadas (puro, testável). */
export function pickAgentActivatedRules(
  rules: AutomationRule[] | null | undefined,
  alreadyTriggered: Set<string>,
): AutomationRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.filter(
    (r) =>
      r?.trigger?.kind === "agent_activated" &&
      !alreadyTriggered.has(r.id) &&
      Array.isArray(r.actions) &&
      r.actions.length > 0,
  );
}

export interface RunActivatedOpts {
  agentId: string;
  locationId: string;
  contactId: string;
  /** De onde veio a ativação (vai pro audit). */
  source: "manual_resume" | "manual_switch";
  /**
   * Injeção pra teste: substitui o executor real (reaction-engine) e/ou o
   * client supabase. Em produção, deixar undefined.
   */
  deps?: {
    supabase?: SupabaseClient;
    execute?: (
      rules: AutomationRule[],
      ctx: {
        agentId: string;
        locationId: string;
        companyId: string;
        contactId: string;
        conversationId: string;
        channel?: string;
      },
    ) => Promise<{ executedRuleIds: string[] }>;
  };
}

/**
 * Caminho MANUAL: carrega config + estado, filtra, executa e persiste o dedup.
 * Devolve quantas regras dispararam (0 = nada a fazer / dedup / erro engolido).
 */
export async function runAgentActivatedAutomations(opts: RunActivatedOpts): Promise<{ fired: number }> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = (opts.deps?.supabase || createAdminClient()) as SupabaseClient;

    // Config do agente — sem regra agent_activated, sai barato (caminho comum).
    const { data: cfg } = await supabase
      .from("agent_configs")
      .select("automations")
      .eq("agent_id", opts.agentId)
      .maybeSingle();
    const rules = (cfg?.automations || null) as AutomationRule[] | null;
    if (!Array.isArray(rules) || !rules.some((r) => r?.trigger?.kind === "agent_activated")) {
      return { fired: 0 };
    }

    // Estado da conversa: dedup + conversation_id pro audit.
    const { data: st } = await supabase
      .from("conversation_state")
      .select("triggered_automations, conversation_id")
      .eq("agent_id", opts.agentId)
      .eq("contact_id", opts.contactId)
      .maybeSingle();
    const alreadyTriggered = new Set<string>(
      Array.isArray(st?.triggered_automations) ? (st!.triggered_automations as string[]) : [],
    );
    const toFire = pickAgentActivatedRules(rules, alreadyTriggered);
    if (toFire.length === 0) return { fired: 0 };

    // Review H62: revalida o par agente↔location AQUI (não confia no caller).
    // Um caller futuro passando agentId de outra location executaria ações no
    // contato da location errada — cross-tenant. Mismatch = pula com aviso.
    const { data: ag } = await supabase
      .from("agents")
      .select("location_id")
      .eq("id", opts.agentId)
      .maybeSingle();
    if (!ag || (ag as { location_id?: string }).location_id !== opts.locationId) {
      console.warn(
        `[agent-activated] agente ${opts.agentId} não pertence à location ${opts.locationId} — automação pulada.`,
      );
      return { fired: 0 };
    }

    // company_id pra falar com o Spark Leads.
    const { data: loc } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", opts.locationId)
      .maybeSingle();
    const companyId = (loc as { company_id?: string | null } | null)?.company_id;
    if (!companyId) {
      console.warn(`[agent-activated] location ${opts.locationId} sem company_id — automação pulada.`);
      return { fired: 0 };
    }

    // Review H62: canal da conversa (último inbound conhecido) — sem isso,
    // send_text_fixed/send_media sairiam como SMS numa conversa de IG/WhatsApp.
    let channel: string | undefined;
    try {
      const { data: lastMsg } = await supabase
        .from("message_queue")
        .select("channel")
        .eq("location_id", opts.locationId)
        .eq("contact_id", opts.contactId)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      channel = (lastMsg as { channel?: string } | null)?.channel || undefined;
    } catch {
      // fail-soft: sem canal = default do executor (SMS)
    }

    const ctx = {
      agentId: opts.agentId,
      locationId: opts.locationId,
      companyId,
      contactId: opts.contactId,
      conversationId: (st as { conversation_id?: string } | null)?.conversation_id || "",
      channel,
    };
    const execute =
      opts.deps?.execute ||
      (await import("@/lib/ai/reaction-engine")).executeReactionRules;
    const { executedRuleIds } = await execute(toFire, ctx);

    if (executedRuleIds.length > 0) {
      const merged = Array.from(new Set<string>([...alreadyTriggered, ...executedRuleIds]));
      await supabase
        .from("conversation_state")
        .update({ triggered_automations: merged })
        .eq("agent_id", opts.agentId)
        .eq("contact_id", opts.contactId);
    }

    // Audit (fail-soft): 1 linha resumindo o disparo manual.
    try {
      await supabase.from("execution_log").insert({
        agent_id: opts.agentId,
        location_id: opts.locationId,
        contact_id: opts.contactId,
        conversation_id: ctx.conversationId,
        action_type: "agent_activated_automation",
        action_payload: { source: opts.source, rule_ids: executedRuleIds, attempted: toFire.length },
        success: executedRuleIds.length === toFire.length,
      });
    } catch {
      // audit nunca derruba o caminho
    }
    return { fired: executedRuleIds.length };
  } catch (err) {
    console.warn("[agent-activated] automação de ativação falhou (não-fatal):", err);
    return { fired: 0 };
  }
}
