import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { shouldFireCron } from "@/lib/account-assistant/proactive/cron-evaluator";
import { fireScheduledReminders } from "@/lib/account-assistant/proactive/reminder-runner";
import { fireBulkRecipients } from "@/lib/account-assistant/proactive/bulk-message-runner";
import { dispatchRule } from "@/lib/account-assistant/proactive/dispatcher";
import { pollDeliveryStatuses } from "@/lib/account-assistant/proactive/delivery-status-poller";
import { GHLClient } from "@/lib/ghl/client";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";
import type { ProactiveRule, RepIdentity, ScheduledTrigger } from "@/types/account-assistant";

export const maxDuration = 60;

/**
 * GET /api/cron/sparkbot-proactive
 *
 * Roda a cada 5 minutos (Vercel Cron). Responsabilidades:
 *
 *   1. SCHEDULED rules: avalia cron expression no timezone da location de
 *      cada rep e dispara as que devem rodar AGORA.
 *
 *   2. REACTIVE rules de polling (que não dependem de webhook): detecta
 *      condições por janela de tempo:
 *        - appointment_upcoming: próximos appointments dentro do offset
 *        - opportunity_stale: opps em mesmo stage há >N dias
 *        - task_due_soon / task_overdue: tasks com due_at relativos
 *        - inbound_unanswered: msgs do lead sem resposta há >N horas
 *        - contact_inactive: contatos ativos sem msg há >N dias
 *
 *   3. (Em V3+) WhatsApp envia direto. Em V2 é simulated, então só dispara
 *      se houver session_id ativa pra rep — aqui no cron, não há sessão,
 *      então scheduled rules em V2 ficam visíveis só via "Simular agora".
 *
 * Auth: header `Authorization: Bearer ${CRON_SECRET}` ou Vercel Cron header.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startTs = Date.now();
  const supabase = createAdminClient();

  // Busca todas as regras enabled de qualquer Sparkbot (em produção
  // teremos 1, mas o cron não precisa assumir).
  const { data: rules } = await supabase
    .from("assistant_proactive_rules")
    .select("*")
    .eq("enabled", true);

  if (!rules || rules.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, fired: 0, message: "no rules enabled" });
  }

  // Pra cada regra agendada, avalia se deveria disparar agora.
  // Modo 'real' não está implementado em V2 — cron registra disparo com
  // status='skipped_disabled' indicando que está aguardando V3 (WhatsApp).
  let firedCount = 0;
  let skippedCount = 0;

  for (const rule of rules) {
    if (rule.rule_type === "scheduled") {
      const trigger = rule.trigger_config as ScheduledTrigger;
      if (!trigger?.cron) continue;
      // Pra regra agendada, precisa avaliar pra cada rep elegível.
      // Mas em V2 simulated, não temos sessão de teste aberta no cron, então
      // só logamos o fact que a regra teria disparado (pra UI mostrar
      // "última vez que rodaria"). Disparo real fica pra V3.
      const reps = await getEligibleReps(supabase, rule);
      for (const rep of reps) {
        const tz = await getRepTimezone(supabase, rep);
        const should = shouldFireCron(trigger.cron, tz);
        if (should) {
          // Modo 'real' será habilitado em V3. Em V2 cron registra skip.
          await supabase
            .from("assistant_alert_state")
            .upsert(
              {
                rep_id: rep.id, rule_id: rule.id, target_id: null,
                last_fired_at: new Date().toISOString(),
                status: "skipped_disabled",
                tokens_used: null, cost_usd: null,
              },
              { onConflict: "rep_id,rule_id,target_id" },
            );
          skippedCount++;
        }
      }
    }
    // Reactive rules de polling (briefing, opp_stale, task_due, etc) são
    // tratadas em uma função dedicada por tipo de evento.
    if (rule.rule_type === "reactive") {
      const reactiveResult = await processReactivePolling(rule as ProactiveRule);
      firedCount += reactiveResult.fired;
      skippedCount += reactiveResult.skipped;
    }
  }

  // Processa lembretes agendados (assistant_scheduled_tasks com next_run_at <= now)
  const reminderResult = await fireScheduledReminders();

  // Processa fila de disparo em massa (bulk_message_recipients pending).
  // MAX_PER_TICK=5 dentro do runner — pra job de 100 contatos a 90s drip,
  // praticamente sempre processa 0-1 por tick exceto após pausa/quiet_hours.
  const bulkResult = await fireBulkRecipients();

  // Polling de delivery status (Stevo): verifica se mensagens proativas
  // recentes foram realmente entregues (status terminal), falharam ou
  // ainda estão pendentes. Atualiza metadata + auto-fallback pra web
  // se failed + auto-signal admin se Stevo cair.
  // Fix bug observado em prod 2026-05-06 (35 msgs em 7 dias todas failed
  // sem ninguém perceber porque instância Stevo morreu silenciosamente).
  const pollerResult = await pollDeliveryStatuses().catch((err) => {
    console.warn(
      "[cron] delivery poller falhou (não-fatal):",
      err instanceof Error ? err.message : err,
    );
    return { checked: 0, delivered: 0, failed: 0, still_pending: 0, errors: 1 };
  });

  const durationMs = Date.now() - startTs;
  return NextResponse.json({
    ok: true,
    processed: rules.length,
    rules_fired: firedCount,
    rules_skipped: skippedCount,
    reminders_fired: reminderResult.fired,
    reminders_failed: reminderResult.failed,
    bulk_fired: bulkResult.fired,
    bulk_failed: bulkResult.failed,
    bulk_skipped: bulkResult.skipped,
    bulk_jobs_completed: bulkResult.jobs_completed,
    delivery_poller: pollerResult,
    duration_ms: durationMs,
  });
}

/**
 * POST handler — alias do GET pra suportar `net.http_post` chamado pelo
 * pg_cron do Supabase (que sempre manda POST). Lógica idêntica.
 */
export const POST = GET;

/**
 * Busca reps elegíveis pra uma regra. Filtra por:
 *   1. terms_accepted_at não-nulo (rep aceitou termos)
 *   2. ghl_users contém pelo menos 1 location de um agent ativo do mesmo
 *      agent_id da rule (multi-tenant isolation — regras do agent A nunca
 *      disparam pra reps do agent B)
 *
 * V3+: somar filtro de whitelist (agent_configs.allowed_ghl_users).
 */
async function getEligibleReps(
  supabase: ReturnType<typeof createAdminClient>,
  rule: { agent_id: string },
): Promise<RepIdentity[]> {
  // Resolve location do agent (Sparkbot vive na Hub)
  const { data: agent } = await supabase
    .from("agents")
    .select("location_id, status")
    .eq("id", rule.agent_id)
    .maybeSingle();
  if (!agent || agent.status !== "active") return [];

  // V2: 1 Sparkbot global. Todos os reps com terms aceitos podem ser
  // candidatos; futuro: cruzar com allowed_ghl_users na config do agent.
  //
  // Fix CRITICAL bug 2026-05-06: antes filtrava só por terms_accepted_at.
  // Investigação Pedro descobriu que setup wizard auto-aceita terms quando
  // admin ativa o agent — mas isso NÃO significa que o rep iniciou conversa
  // (opt-in legítimo via WhatsApp). De 54 reps marcados eligíveis, só 4
  // tinham last_inbound_at — 50 receberam proativos pra void (ainda bem
  // que Stevo legacy tava com instância dead, senão era ban garantido pelo
  // Meta — pattern "enviar pra desconhecidos" detecta na hora).
  //
  // Regra agora: SÓ envia proativo pra reps que mandaram pelo menos 1
  // inbound (significa que opted-in via WhatsApp real, não terms-mock).
  // Plus: se rep está pausado (proactive_paused_at) ou rejeitou terms
  // (terms_rejected_at), exclui também. Defense in depth.
  const { data } = await supabase
    .from("rep_identities")
    .select("*")
    .not("terms_accepted_at", "is", null)
    .is("terms_rejected_at", null)
    .is("proactive_paused_at", null)
    .not("last_inbound_at", "is", null)
    .limit(100);
  return (data || []) as RepIdentity[];
}

async function getRepTimezone(
  supabase: ReturnType<typeof createAdminClient>,
  rep: RepIdentity,
): Promise<string> {
  if (!rep.active_location_id) return "America/New_York";
  const { data } = await supabase
    .from("locations")
    .select("timezone")
    .eq("location_id", rep.active_location_id)
    .maybeSingle();
  return data?.timezone || "America/New_York";
}

/**
 * Processa reactive rules que precisam de polling (não dependem de webhook).
 *
 * Implementado 2026-05-04:
 *   - `post_meeting`: pra cada rep elegível, query GHL appointments cujo
 *     endTime caiu na janela [now-30min, now+offset_ms]. Pra cada match
 *     dispara via dispatchRule(mode='real', targetId=appointment.id). O
 *     atomic claim em assistant_alert_state (UNIQUE rep+rule+target)
 *     impede duplicate disparos pro mesmo appointment.
 *
 * Outros eventos (`task_due_soon`, `task_overdue`, `contact_inactive`,
 * `inbound_unanswered`, etc) ainda são stub — precisam polling específico
 * por endpoint do Spark Leads. Logam debug e retornam 0/0.
 */
async function processReactivePolling(rule: ProactiveRule): Promise<{ fired: number; skipped: number }> {
  const trigger = rule.trigger_config as Record<string, unknown> | null;
  const event = typeof trigger?.event === "string" ? trigger.event : null;
  if (event === "post_meeting") {
    return processPostMeetingPolling(rule);
  }
  // Outros eventos: ainda não implementados em V2. Não loga warning ruidoso
  // — só registra debug pra histórico e segue.
  console.log(`[cron] reactive event '${event}' ainda não implementado (rule=${rule.name})`);
  return { fired: 0, skipped: 0 };
}

/**
 * Polling do evento `post_meeting`: detecta appointments cujo endTime
 * acabou de cair na janela alvo. Janela:
 *   [now() - GRACE_MINUTES, now() + offset_minutes]
 *
 * - GRACE de 30min cobre cron travado / restart Vercel — se reunião
 *   acabou faz 25min e nunca disparamos, ainda dispara.
 * - offset_minutes da rule (default 0 = imediato; 20 = espera 20min após).
 *
 * Anti-duplicate: assistant_alert_state UNIQUE(rep_id, rule_id, target_id)
 * via tryClaimDispatchSlot — mesmo appointment nunca dispara 2x.
 *
 * Não dispara pra status `cancelled`/`noshow`/`invalid` (reunião não
 * aconteceu, post_meeting não faz sentido).
 */
async function processPostMeetingPolling(
  rule: ProactiveRule,
): Promise<{ fired: number; skipped: number }> {
  const supabase = createAdminClient();
  const trigger = rule.trigger_config as Record<string, unknown>;
  const offsetMinutes =
    typeof trigger?.offset_minutes === "number" ? trigger.offset_minutes : 0;
  const offsetMs = offsetMinutes * 60_000;
  const GRACE_MS = 30 * 60_000;
  const now = Date.now();
  const windowStart = now - GRACE_MS;
  const windowEnd = now + offsetMs;

  const reps = await getEligibleReps(supabase, rule);
  let fired = 0;
  let skipped = 0;

  for (const rep of reps) {
    // Itera TODAS as locations do rep, não só active_location_id. Reps
    // multi-location (ex: agency owner com 6 sub-accounts) podem ter
    // appointments em qualquer location — o cron precisa olhar em todas.
    // De-duplica por location_id (caso ghl_users[] tenha entries dup).
    const locationsByRep = new Map<string, string>(); // location_id → ghl_user_id
    for (const u of rep.ghl_users || []) {
      if (u?.location_id && u?.ghl_user_id && !locationsByRep.has(u.location_id)) {
        locationsByRep.set(u.location_id, u.ghl_user_id);
      }
    }
    if (locationsByRep.size === 0) {
      skipped++;
      continue;
    }

    for (const [locationId, ghlUserId] of locationsByRep) {
      const { data: location } = await supabase
        .from("locations")
        .select("location_id, company_id")
        .eq("location_id", locationId)
        .maybeSingle();
      if (!location) {
        // Location não está sincronizada na tabela — sem company_id não
        // dá pra montar GHLClient. Pula silenciosamente.
        skipped++;
        continue;
      }

      try {
        const ghlClient = new GHLClient(location.company_id, locationId);
        // Query +/- 1h da janela alvo pra cobrir reuniões longas (que
        // começaram antes da janela mas terminam dentro). API retorna
        // eventos cujo [start, end] intercepta [queryStart, queryEnd].
        const queryStart = windowStart - 60 * 60_000;
        const queryEnd = windowEnd + 60_000;
        const res = await ghlClient.get<{
          events?: Array<{
            id: string;
            title?: string;
            startTime: string;
            endTime: string;
            contactId?: string;
            appointmentStatus?: string;
            assignedUserId?: string;
          }>;
        }>("/calendars/events", {
          locationId,
          startTime: String(queryStart),
          endTime: String(queryEnd),
          userId: ghlUserId,
        });

        for (const event of res.events || []) {
          const endMs = new Date(event.endTime).getTime();
          if (isNaN(endMs)) continue;
          // Filtro fino: só appointments cujo endTime caiu DENTRO da janela
          if (endMs < windowStart || endMs > windowEnd) continue;
          const status = (event.appointmentStatus || "scheduled").toLowerCase();
          if (
            status === "cancelled" ||
            status === "noshow" ||
            status === "no-show" ||
            status === "invalid"
          ) {
            skipped++;
            continue;
          }

          // Dispara via dispatcher mode='real'. overrideLocationId garante
          // que tools (get_contact, etc) rodem contra a location onde o
          // appointment está — não a active_location do rep. Sem isso,
          // get_contact buscaria em location errada e falharia.
          // Cooldown atomic via UNIQUE (rep_id, rule_id, target_id=appt.id).
          const result = await dispatchRule({
            rule,
            rep,
            targetId: event.id,
            overrideLocationId: locationId,
            contextData: {
              event: "post_meeting",
              appointment_id: event.id,
              title: event.title || null,
              start_time: event.startTime,
              end_time: event.endTime,
              contact_id: event.contactId || null,
              meeting_location_id: locationId,
              status,
            },
            mode: "real",
          });
          if (result.status === "sent") fired++;
          else skipped++;
        }
      } catch (err) {
        console.warn(
          `[cron] post_meeting polling falhou pra rep ${rep.id} ` +
            `na location ${locationId}:`,
          err instanceof Error ? err.message : err,
        );
        skipped++;
      }
    }
  }

  return { fired, skipped };
}
