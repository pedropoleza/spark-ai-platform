import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { buildFollowUpPrompt } from "@/lib/ai/sales-prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import { trackAndCharge } from "@/lib/billing/charge";
import { withRetry } from "@/lib/utils/retry";
// F59 (Fix bug observado em prod 2026-06-04): mesma rede de segurança do
// queue-processor — se o histórico do Spark Leads falhar, o follow-up não pode
// virar uma re-apresentação fria. Reconstrói do nosso DB.
import { reconstructHistoryFromDb } from "@/lib/queue/history-fallback";
import { reportError } from "@/lib/admin-signals/report-error";
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

  try {
    // Cancela os follow-ups pendentes anteriores deste contato.
    // F46/F47 (fix review 2026-06-05): supabase-js NÃO lança — devolve {error}.
    // Se o cancel falhar e a gente recriar mesmo assim, a sequência ACUMULA
    // (N novos por cima dos N antigos não-cancelados = spam ao lead). Então:
    // cancel com erro → NÃO recria + sinaliza. Antes o erro era engolido.
    const { error: cancelErr } = await supabase
      .from("scheduled_followups")
      .update({ status: "cancelled" })
      .eq("agent_id", agentId)
      .eq("contact_id", contactId)
      .eq("status", "pending");
    if (cancelErr) {
      reportError({
        title: "Follow-up: falha ao cancelar pendentes (abortado p/ não duplicar)",
        feature: "followup-scheduler",
        severity: "high",
        error: cancelErr,
        metadata: { agentId, contactId, locationId },
      });
      return;
    }

    // Monta a sequência nova e insere em LOTE (era N inserts separados).
    const rows: Array<Record<string, unknown>> = [];
    if (followUpConfig.mode === "manual") {
      for (let i = 0; i < followUpConfig.manual_steps.length; i++) {
        const step = followUpConfig.manual_steps[i];
        rows.push({
          agent_id: agentId,
          location_id: locationId,
          contact_id: contactId,
          conversation_id: conversationId,
          attempt_number: i + 1,
          scheduled_at: new Date(Date.now() + step.delay_minutes * 60 * 1000).toISOString(),
          custom_message: step.custom_message || null,
          status: "pending",
        });
      }
    } else {
      // Modo ai_auto: distribui pela intensidade entre min/max.
      const maxAttempts = Math.min(followUpConfig.max_attempts, 10);
      const intensity = followUpConfig.intensity;
      const minDelay = followUpConfig.min_delay_minutes || 10;
      const maxDelay = followUpConfig.max_delay_minutes || 10080; // 7 dias
      for (let i = 0; i < maxAttempts; i++) {
        const totalDelayMinutes = calculateCumulativeDelay(i + 1, intensity, maxAttempts, minDelay, maxDelay);
        rows.push({
          agent_id: agentId,
          location_id: locationId,
          contact_id: contactId,
          conversation_id: conversationId,
          attempt_number: i + 1,
          scheduled_at: new Date(Date.now() + totalDelayMinutes * 60 * 1000).toISOString(),
          status: "pending",
        });
      }
    }

    if (rows.length === 0) return;
    const { error: insErr } = await supabase.from("scheduled_followups").insert(rows);
    if (insErr) {
      reportError({
        title: "Follow-up: falha ao agendar sequência",
        feature: "followup-scheduler",
        severity: "high",
        error: insErr,
        metadata: { agentId, contactId, locationId, attempts: rows.length },
      });
    }
  } catch (err) {
    reportError({
      title: "Follow-up: exceção ao agendar",
      feature: "followup-scheduler",
      severity: "high",
      error: err,
      metadata: { agentId, contactId, locationId },
    });
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
      // Fix MED-2 + HIGH-6 (deep review 2026-05-05):
      //  - Inclui "stale" em completedStatuses (antes não cancelava — bot
      //    encerrava conversa mas follow-ups continuavam).
      //  - Checa ai_paused_at: se admin pausou IA pra handoff humano,
      //    follow-ups bot NÃO devem disparar.
      const { data: convState } = await supabase
        .from("conversation_state")
        .select("status, collected_data, conversation_id, ai_paused_at")
        .eq("agent_id", followUp.agent_id)
        .eq("contact_id", followUp.contact_id)
        .single();

      const completedStatuses = ["qualified", "booked", "disqualified", "handed_off", "stale"];
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

      // ai_paused_at: humano assumiu, bot fica em silêncio.
      if (convState && (convState as { ai_paused_at?: string }).ai_paused_at) {
        console.log(
          `[FollowUp] Skipping pra contact=${followUp.contact_id} — ai_paused_at setado.`,
        );
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

      // GU-3/F52 (Fix bug observado em prod 2026-06-04): captura o texto enviado
      // pra LOGAR no execution_log depois. Sem esse log o follow-up fica
      // INVISÍVEL: o loader (👍/👎) e o anti-eco do F52 identificam "mensagem da
      // IA" por execution_log.send_message — era o "não mostra thumbs no follow-up".
      let sentText: string | null = null;

      // Se tem mensagem customizada, enviar direto
      if (followUp.custom_message) {
        await client.post("/conversations/messages", {
          type: "SMS",
          contactId: followUp.contact_id,
          message: followUp.custom_message,
        });
        sentText = followUp.custom_message;
      } else {
        // Buscar contexto recente (últimas 10 msgs + nome) para personalizar o follow-up.
        // Dois fetches em paralelo para minimizar latência do scheduler.
        const convId = (convState as { conversation_id?: string } | null)?.conversation_id || "";
        const [historyResult, contactResult] = await Promise.allSettled([
          convId
            ? withRetry(
                () =>
                  client.get<{ messages: { messages: { direction: string; body?: string; dateAdded: string; messageType?: string }[] } }>(
                    `/conversations/${convId}/messages`,
                    { locationId: followUp.location_id },
                  ),
                { maxRetries: 2, baseDelayMs: 200, label: "followup-conv-messages" },
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

        // F59 (Fix bug observado em prod 2026-06-04): se o histórico do Spark
        // Leads veio vazio/falhou (mesmo com retry), reconstrói do nosso DB pro
        // follow-up não sair FRIO ("Oi! Sou Assistente..." numa conversa que já
        // estava avançada). Mesma rede de segurança do queue-processor.
        if (!recentHistory.trim()) {
          const dbTurns = await reconstructHistoryFromDb({
            supabase,
            locationId: followUp.location_id,
            contactId: followUp.contact_id,
            limit: 10,
          });
          if (dbTurns.length > 0) {
            recentHistory = dbTurns
              .map((t) => `${t.role === "user" ? "LEAD" : "AGENTE"}: ${t.content.substring(0, 300)}`)
              .join("\n");
            console.warn(
              `[FollowUp] F59 history fallback: ${dbTurns.length} turns do DB pra contact=${followUp.contact_id}`,
            );
          }
        }

        let contactName: string | undefined;
        if (contactResult.status === "fulfilled" && contactResult.value?.contact) {
          const c = contactResult.value.contact;
          contactName = c.name || c.firstName || undefined;
        }

        const collectedData = (convState as { collected_data?: Record<string, string> } | null)?.collected_data || {};

        const followUpPrompt = buildFollowUpPrompt({
          config,
          agentType: agent.type as "sales_agent" | "recruitment_agent",
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

        // C3: cobrar follow-up. Antes deste fix rodava 100% free.
        // Estimativa: 30% leads × 5 follow-ups × $0.005 = $22.50/mês/location.
        try {
          let usesCustomKey = false;
          try {
            const { data: ls } = await supabase
              .from("location_settings")
              .select("openai_api_key")
              .eq("location_id", followUp.location_id)
              .maybeSingle();
            usesCustomKey = !!ls?.openai_api_key;
          } catch { /* sem location_settings */ }

          await trackAndCharge({
            locationId: followUp.location_id,
            companyId: location.company_id,
            agentId: followUp.agent_id,
            contactId: followUp.contact_id,
            actionType: "follow_up",
            model: config.ai_model || "gpt-4.1-mini",
            promptTokens: result.prompt_tokens || 0,
            completionTokens: result.completion_tokens || 0,
            cachedTokens: result.cached_tokens || 0,
            usesCustomKey,
          });
        } catch (e) {
          console.error("[FollowUp] Billing failed (non-blocking):", e instanceof Error ? e.message : e);
        }

        if (result.success && result.response?.message) {
          // Fix HIGH-5 (deep review 2026-05-05): normalizar message — pode
          // vir como string OU array. Antes mandava o array serializado
          // direto pra GHL (400 ou comportamento estranho).
          const msgRaw = result.response.message;
          const msgText = Array.isArray(msgRaw)
            ? msgRaw.filter((s) => typeof s === "string" && s.trim()).join("\n\n")
            : String(msgRaw);
          if (msgText.trim()) {
            await client.post("/conversations/messages", {
              type: "SMS",
              contactId: followUp.contact_id,
              message: msgText.trim(),
            });
            sentText = msgText.trim();
          }
        }
      }

      // GU-3/F52/F59: registra o envio do follow-up no execution_log com o MESMO
      // shape do fluxo principal (action_payload.message = string[]). Resolve 3
      // coisas de uma vez: (1) o loader passa a mostrar 👍/👎 no follow-up,
      // (2) o anti-eco do F52 reconhece como envio da IA (não pausa falso no
      // próximo inbound), (3) o histórico reconstruído (F59) inclui o follow-up.
      if (sentText && sentText.trim()) {
        await supabase.from("execution_log").insert({
          agent_id: followUp.agent_id,
          conversation_id: (convState as { conversation_id?: string } | null)?.conversation_id || "",
          contact_id: followUp.contact_id,
          location_id: followUp.location_id,
          action_type: "send_message",
          action_payload: {
            message: [sentText.trim()],
            source: "follow_up",
            attempt_number: followUp.attempt_number,
          },
          success: true,
        });
      }

      await supabase.from("scheduled_followups").update({ status: "sent" }).eq("id", followUp.id);
      sent++;
    } catch (error) {
      console.error("Erro no follow-up:", error);
      // F49 (review 2026-06-05): falha do runner não pode ser silenciosa.
      reportError({
        title: "Follow-up runner: falha ao processar/enviar",
        feature: "followup-runner",
        severity: "medium",
        error,
        metadata: {
          followUpId: followUp.id,
          contactId: followUp.contact_id,
          locationId: followUp.location_id,
          attempt: followUp.attempt_number,
        },
      });
      await supabase.from("scheduled_followups").update({ status: "failed" }).eq("id", followUp.id);
      errors++;
    }
  }

  return { sent, errors };
}
