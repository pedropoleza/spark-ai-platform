import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { shouldFireCron } from "@/lib/account-assistant/proactive/cron-evaluator";
import { fireScheduledReminders } from "@/lib/account-assistant/proactive/reminder-runner";
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
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    const isVercelCron = request.headers.get("x-vercel-cron") === "1";
    if (!isVercelCron && auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
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

  const durationMs = Date.now() - startTs;
  return NextResponse.json({
    ok: true,
    processed: rules.length,
    rules_fired: firedCount,
    rules_skipped: skippedCount,
    reminders_fired: reminderResult.fired,
    reminders_failed: reminderResult.failed,
    duration_ms: durationMs,
  });
}

/**
 * Busca reps elegíveis pra uma regra. V2: todos os reps cadastrados.
 * V3+: filtrar por whitelist de allowed_ghl_users no agent_config.
 */
async function getEligibleReps(
  supabase: ReturnType<typeof createAdminClient>,
  _rule: { agent_id: string }, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<RepIdentity[]> {
  const { data } = await supabase
    .from("rep_identities")
    .select("*")
    .not("terms_accepted_at", "is", null)
    .limit(50);
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
 * Em V2 simulated, só rastreia que detectou condição. Em V3, dispara.
 */
async function processReactivePolling(rule: ProactiveRule): Promise<{ fired: number; skipped: number }> {
  // Stub simplificado — implementação detalhada por tipo de evento fica
  // pra quando V3 ativar (dispatch real via WhatsApp).
  // Em V2, scheduled e reactive cron são apenas logados como skipped_disabled
  // pra mostrar no histórico que detectaram condição mas ainda não enviam.
  void rule;
  return { fired: 0, skipped: 0 };
}
