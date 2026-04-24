import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { buildFollowUpPrompt } from "@/lib/ai/prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import type { FollowUpConfig } from "@/types/agent";

/**
 * Agenda follow-ups para uma conversa que ficou inativa.
 * Chamado apos cada processamento de mensagem.
 */
export async function scheduleFollowUps(params: {
  agentId: string;
  locationId: string;
  contactId: string;
  conversationId: string;
  followUpConfig: FollowUpConfig;
}): Promise<void> {
  const { agentId, locationId, contactId, conversationId, followUpConfig } = params;

  if (!followUpConfig.enabled) return;

  const supabase = createAdminClient();

  // Cancelar follow-ups anteriores pendentes para este contato
  await supabase
    .from("scheduled_followups")
    .update({ status: "cancelled" })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .eq("status", "pending");

  if (followUpConfig.mode === "manual") {
    // Modo manual: agendar cada step definido
    for (let i = 0; i < followUpConfig.manual_steps.length; i++) {
      const step = followUpConfig.manual_steps[i];
      const scheduledAt = new Date(Date.now() + step.delay_minutes * 60 * 1000);

      await supabase.from("scheduled_followups").insert({
        agent_id: agentId,
        location_id: locationId,
        contact_id: contactId,
        conversation_id: conversationId,
        attempt_number: i + 1,
        scheduled_at: scheduledAt.toISOString(),
        custom_message: step.custom_message || null,
        status: "pending",
      });
    }
  } else {
    // Modo ai_auto: agendar baseado na intensidade + limites min/max
    const maxAttempts = Math.min(followUpConfig.max_attempts, 10);
    const intensity = followUpConfig.intensity;
    const minDelay = followUpConfig.min_delay_minutes || 10;
    const maxDelay = followUpConfig.max_delay_minutes || 10080; // 7 dias

    for (let i = 0; i < maxAttempts; i++) {
      const totalDelayMinutes = calculateCumulativeDelay(i + 1, intensity, maxAttempts, minDelay, maxDelay);
      const scheduledAt = new Date(Date.now() + totalDelayMinutes * 60 * 1000);

      await supabase.from("scheduled_followups").insert({
        agent_id: agentId,
        location_id: locationId,
        contact_id: contactId,
        conversation_id: conversationId,
        attempt_number: i + 1,
        scheduled_at: scheduledAt.toISOString(),
        status: "pending",
      });
    }
  }
}

/**
 * Calcula o delay cumulativo para cada follow-up distribuindo entre min e max.
 *
 * A intensidade controla como os follow-ups sao distribuidos no intervalo:
 * - Intensidade 10 (agressivo): intervalos curtos, concentrados no inicio
 * - Intensidade 1 (leve): intervalos longos, espacados uniformemente
 *
 * minDelay = tempo do 1o follow-up (default 10 min)
 * maxDelay = tempo total ate o ultimo follow-up (default 7 dias = 10080 min)
 */
function calculateCumulativeDelay(
  attemptNumber: number,
  intensity: number,
  maxAttempts: number,
  minDelay: number,
  maxDelay: number
): number {
  if (maxAttempts <= 1) return minDelay;

  // Fator de progressao: intensidade alta = progressao lenta (intervalos curtos),
  // intensidade baixa = progressao rapida (intervalos longos no inicio)
  // Expoente: 0.3 (agressivo) a 3.0 (leve)
  const exponent = 0.3 + ((10 - intensity) / 9) * 2.7;

  // Posicao normalizada do attempt (0 a 1)
  const t = (attemptNumber - 1) / (maxAttempts - 1);

  // Curva exponencial entre minDelay e maxDelay
  const delay = minDelay + (maxDelay - minDelay) * Math.pow(t, exponent);

  return Math.round(delay);
}

/**
 * Processa follow-ups agendados que estao prontos
 * Chamado pelo cron job
 */
export async function processScheduledFollowUps(): Promise<{ sent: number; errors: number }> {
  const supabase = createAdminClient();
  let sent = 0;
  let errors = 0;

  // ATOMIC: marcar como processing e retornar em uma operação
  const { data: pending } = await supabase
    .from("scheduled_followups")
    .update({ status: "processing" })
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .select("*")
    .order("scheduled_at", { ascending: true })
    .limit(20);

  if (!pending || pending.length === 0) return { sent: 0, errors: 0 };

  for (const followUp of pending) {
    try {
      // Verificar se o objetivo ja foi cumprido (cancelar se sim).
      // Buscamos também collected_data e conversation_id para personalizar o follow-up.
      const { data: convState } = await supabase
        .from("conversation_state")
        .select("status, collected_data, conversation_id")
        .eq("agent_id", followUp.agent_id)
        .eq("contact_id", followUp.contact_id)
        .single();

      const completedStatuses = ["qualified", "booked", "disqualified", "handed_off"];
      if (convState && completedStatuses.includes(convState.status)) {
        // Objetivo cumprido, cancelar todos os follow-ups
        await supabase
          .from("scheduled_followups")
          .update({ status: "cancelled" })
          .eq("agent_id", followUp.agent_id)
          .eq("contact_id", followUp.contact_id)
          .in("status", ["pending", "processing"]);
        continue;
      }

      // Verificar DND/opted-out no GHL antes de enviar
      const { data: locData } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", followUp.location_id)
        .single();

      if (locData) {
        try {
          const dndClient = new GHLClient(locData.company_id, followUp.location_id);
          const contactCheck = await dndClient.get<{
            contact: { dnd?: boolean; dndSettings?: { all?: { status?: string } } };
          }>(`/contacts/${followUp.contact_id}`);

          const isDND = contactCheck.contact?.dnd ||
            contactCheck.contact?.dndSettings?.all?.status === "active";

          if (isDND) {
            console.log(`[FollowUp] Contact ${followUp.contact_id} is DND, cancelling`);
            await supabase
              .from("scheduled_followups")
              .update({ status: "cancelled" })
              .eq("agent_id", followUp.agent_id)
              .eq("contact_id", followUp.contact_id)
              .in("status", ["pending", "processing"]);
            continue;
          }
        } catch {
          // Se não conseguiu verificar DND, não enviar por segurança
          console.warn("[FollowUp] Could not verify DND, skipping");
          await supabase.from("scheduled_followups").update({ status: "failed" }).eq("id", followUp.id);
          errors++;
          continue;
        }
      }

      // Verificar se o lead respondeu desde o agendamento (cancelar se sim)
      const { data: recentMessages } = await supabase
        .from("message_queue")
        .select("id")
        .eq("location_id", followUp.location_id)
        .eq("contact_id", followUp.contact_id)
        .eq("message_direction", "inbound")
        .gt("received_at", followUp.scheduled_at)
        .limit(1);

      if (recentMessages && recentMessages.length > 0) {
        // Lead respondeu, cancelar todos os follow-ups pendentes
        await supabase
          .from("scheduled_followups")
          .update({ status: "cancelled" })
          .eq("agent_id", followUp.agent_id)
          .eq("contact_id", followUp.contact_id)
          .eq("status", "processing");
        continue;
      }

      // Buscar config do agente (so processa se ativo)
      const { data: agent } = await supabase
        .from("agents")
        .select("*, agent_configs(*)")
        .eq("id", followUp.agent_id)
        .eq("status", "active")
        .maybeSingle();

      if (!agent) {
        // Agente nao encontrado ou desativado — cancelar follow-up
        await supabase.from("scheduled_followups").update({ status: "cancelled" }).eq("id", followUp.id);
        continue;
      }

      const config = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;
      if (!config) {
        await supabase.from("scheduled_followups").update({ status: "failed" }).eq("id", followUp.id);
        errors++;
        continue;
      }

      // Buscar location
      const { data: location } = await supabase
        .from("locations")
        .select("*")
        .eq("location_id", followUp.location_id)
        .single();

      if (!location) {
        await supabase.from("scheduled_followups").update({ status: "failed" }).eq("id", followUp.id);
        errors++;
        continue;
      }

      const client = new GHLClient(location.company_id, followUp.location_id);

      // Se tem mensagem customizada, enviar direto
      if (followUp.custom_message) {
        await client.post("/conversations/messages", {
          type: "SMS",
          contactId: followUp.contact_id,
          message: followUp.custom_message,
        });
      } else {
        // Buscar contexto recente (últimas 10 msgs + nome) para personalizar o follow-up.
        // Dois fetches em paralelo para minimizar latência do scheduler.
        const convId = (convState as { conversation_id?: string } | null)?.conversation_id || "";
        const [historyResult, contactResult] = await Promise.allSettled([
          convId
            ? client.get<{ messages: { messages: { direction: string; body?: string; dateAdded: string; messageType?: string }[] } }>(
                `/conversations/${convId}/messages`,
                { locationId: followUp.location_id },
              )
            : Promise.resolve(null),
          client.get<{ contact: { firstName?: string; name?: string } }>(`/contacts/${followUp.contact_id}`),
        ]);

        let recentHistory = "";
        if (historyResult.status === "fulfilled" && historyResult.value) {
          const msgs = historyResult.value.messages?.messages || [];
          recentHistory = msgs
            .filter((m) => m.messageType === "TYPE_CUSTOM_SMS" || m.body)
            .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime())
            .slice(-10)
            .map((m) => {
              const dir = m.direction === "inbound" ? "LEAD" : "AGENTE";
              return `${dir}: ${(m.body || "").substring(0, 300)}`;
            })
            .join("\n");
        }

        let contactName: string | undefined;
        if (contactResult.status === "fulfilled" && contactResult.value?.contact) {
          const c = contactResult.value.contact;
          contactName = c.name || c.firstName || undefined;
        }

        const collectedData = (convState as { collected_data?: Record<string, string> } | null)?.collected_data || {};

        const followUpPrompt = buildFollowUpPrompt({
          config,
          agentType: agent.type as "sales_agent" | "post_sales_agent",
          attemptNumber: followUp.attempt_number,
          locationName: location.location_name || "Nossa empresa",
          currentDate: new Date().toLocaleDateString("pt-BR"),
          timezone: location.timezone || "America/New_York",
          contactName,
          collectedData,
          recentHistory,
        });

        const result = await processWithAI({
          systemPrompt: followUpPrompt,
          conversationHistory: "",
          newMessages: `Follow-up #${followUp.attempt_number} para o lead. Gere uma unica mensagem de follow-up.`,
          model: config.ai_model || "gpt-4.1-mini",
        });

        if (result.success && result.response?.message) {
          await client.post("/conversations/messages", {
            type: "SMS",
            contactId: followUp.contact_id,
            message: result.response.message,
          });
        }
      }

      await supabase.from("scheduled_followups").update({ status: "sent" }).eq("id", followUp.id);
      sent++;
    } catch (error) {
      console.error("Erro no follow-up:", error);
      await supabase.from("scheduled_followups").update({ status: "failed" }).eq("id", followUp.id);
      errors++;
    }
  }

  return { sent, errors };
}
