/**
 * Campaign populator (Etapa 4.4 — Pedro 2026-05-28).
 *
 * Quando um bulk_message_job vira `running` pela primeira vez (vindo de
 * 'paused' criado via /hub/campaigns/new), este módulo resolve a lista de
 * contatos via Filter Engine (pela tag salva em filter_config.tag) e popula:
 *   - bulk_message_recipients (1 por contato — step 1 da sequência, ou single-shot)
 *   - bulk_message_sequence_state (1 por contato, só se job.has_sequence)
 *
 * Idempotente: se já há recipients pro job, retorna noop. Permite admin
 * pause+resume sem duplicar fila.
 *
 * NÃO faz envio — só enfileira. O bulk-message-runner já existente consome
 * os recipients quando scheduled_at vence. Sequence-runner avança state pra
 * steps 2+.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { executeContactsFilter } from "@/lib/account-assistant/filter-engine";
// F60 (Pedro 2026-06-10): enforcement do cap diário (espalha recipients ≤ teto
// por dia-ET). Ponto único de distribuição cap-aware, reusado pelo recurring-runner.
import { getDailyCap, buildCappedScheduledAts } from "@/lib/account-assistant/tools/bulk-messages";
import type {
  ContactResult,
  FilterExpression,
  FilterExecutionContext,
} from "@/lib/account-assistant/filter-engine";

const INSERT_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PopulateResult {
  ok: boolean;
  populated: number;
  state_created: number;
  reason?: string;
}

export async function populateCampaignRecipients(jobId: string): Promise<PopulateResult> {
  const supabase = createAdminClient();

  // 1. Lê o job. Precisa estar running E ter filter_config.tag.
  const { data: job } = await supabase
    .from("bulk_message_jobs")
    .select(
      "id, status, location_id, agent_id, rep_id, filter_config, message_template, interval_seconds, jitter_seconds, has_sequence, ab_variants, daily_cap",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, populated: 0, state_created: 0, reason: "job_not_found" };

  const tag = (job.filter_config as { tag?: string } | null)?.tag;
  if (!tag) return { ok: false, populated: 0, state_created: 0, reason: "no_tag_in_filter_config" };

  // 2. Idempotência: noop se já tem recipients.
  const { count: existing } = await supabase
    .from("bulk_message_recipients")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  if ((existing ?? 0) > 0) {
    return { ok: true, populated: 0, state_created: 0, reason: "already_populated" };
  }

  // 3. Resolve location (precisa do company_id pro GHL client).
  const { data: location } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", job.location_id)
    .maybeSingle();
  if (!location?.company_id) {
    return { ok: false, populated: 0, state_created: 0, reason: "location_not_synced" };
  }

  // 4. Executa Filter Engine: contatos com a tag.
  const ghlClient = new GHLClient(location.company_id, job.location_id);
  const filterCtx: FilterExecutionContext = {
    rep_id: job.rep_id,
    location_id: job.location_id,
    company_id: location.company_id,
    agent_id: job.agent_id ?? undefined,
    ghl_client: ghlClient,
    consumer_tool: "campaign_populator",
  };
  // FEL: contato cujo array `tags` contém o valor. Engine resolve.
  const filterExpr: FilterExpression = {
    field: "tags",
    op: "contains",
    value: tag,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const filterResult = await executeContactsFilter(filterExpr, filterCtx, { limit: 5000 });
  if (filterResult.status !== "ok") {
    return {
      ok: false,
      populated: 0,
      state_created: 0,
      reason: `filter_failed:${filterResult.status}`,
    };
  }
  const contacts: ContactResult[] = filterResult.items || [];
  if (contacts.length === 0) {
    return { ok: true, populated: 0, state_created: 0, reason: "no_contacts_match_tag" };
  }

  // 5. Carrega sequências (pra ter delay_days do step 2 quando has_sequence).
  let sequencesByStep: { step_number: number; delay_days: number; template: string }[] = [];
  if (job.has_sequence) {
    const { data: seqs } = await supabase
      .from("bulk_message_sequences")
      .select("step_number, delay_days, template")
      .eq("job_id", jobId)
      .order("step_number", { ascending: true });
    sequencesByStep = (seqs || []) as typeof sequencesByStep;
  }
  const isSequence = sequencesByStep.length > 1;
  const step2DelayDays = isSequence ? sequencesByStep[1].delay_days : 0;

  // 6. Computa scheduled_at espalhado por interval_seconds + jitter aleatório
  // dentro da janela jitter_seconds. Mesma lógica do schedule_bulk_message_v2.
  const interval = Math.max(30, job.interval_seconds || 90);
  const jitter = Math.max(0, job.jitter_seconds || 30);
  const baseStart = new Date(Date.now() + 5000); // 5s buffer pra evitar sair antes do PATCH retornar

  // F60 (Pedro 2026-06-10): teto diário. Lê o snapshot persistido no job
  // (daily_cap); se for legado/NULL, faz fallback resolvendo o cap do agente em
  // runtime (getDailyCap = daily_bulk_message_cap) pra nenhum job ficar sem
  // proteção. buildCappedScheduledAts espalha os contatos ≤ cap por dia-ET
  // (overflow rola pro próximo dia 09:00 ET), semeando o uso de hoje via
  // countRecipientsLast24h. cap NULL = linear histórico (sem mudança). Diferente
  // do chat path (que TRUNCA): aqui ESPALHA — a promessa "até N/dia" é de ritmo,
  // não de descarte (ver bloco F60 em bulk-messages.ts).
  const dailyCap = job.daily_cap ?? (await getDailyCap(job.agent_id));
  const scheduledAts = await buildCappedScheduledAts({
    locationId: job.location_id,
    count: contacts.length,
    dailyCap,
    intervalSeconds: interval,
    jitterSeconds: jitter,
    baseStart,
  });

  // Etapa 4.7: prepara distribuição de variants se job tem ab_variants.
  // Sorteio por weight normalizado. Salva variant_id (1-based) +
  // message_template_override em cada recipient.
  type AbVariant = { template: string; weight: number };
  const abVariants = (job.ab_variants as AbVariant[] | null) || null;
  const hasAb = Array.isArray(abVariants) && abVariants.length >= 2;
  let totalWeight = 0;
  if (hasAb && abVariants) {
    for (const v of abVariants) totalWeight += Math.max(1, v.weight);
  }
  function pickVariant(): { variantId: number; template: string } | null {
    if (!hasAb || !abVariants || totalWeight <= 0) return null;
    const r = Math.random() * totalWeight;
    let cumulative = 0;
    for (let i = 0; i < abVariants.length; i++) {
      cumulative += Math.max(1, abVariants[i].weight);
      if (r < cumulative) {
        return { variantId: i + 1, template: abVariants[i].template };
      }
    }
    return { variantId: abVariants.length, template: abVariants[abVariants.length - 1].template };
  }

  const recipientRows = contacts.map((c, i) => {
    const variant = pickVariant();
    return {
      job_id: jobId,
      contact_id: c.id,
      contact_name: c.name,
      contact_phone: c.phone,
      // F60: scheduled_at distribuído respeitando o cap por dia-ET (acima).
      scheduled_at: scheduledAts[i].toISOString(),
      status: "pending" as const,
      // step 1 usa job.message_template (= sequences[0].template). Não precisa
      // override aqui. Steps 2+ sequenciados pelo sequence-runner.
      sequence_step: isSequence ? 1 : null,
      // Etapa 4.7: A/B distribui template via override + variant_id pra stats.
      message_template_override: variant?.template ?? null,
      variant_id: variant?.variantId ?? null,
    };
  });

  // 7. INSERT em batches.
  const insertedIds: { id: string; scheduled_at: string }[] = [];
  for (let i = 0; i < recipientRows.length; i += INSERT_BATCH) {
    const chunk = recipientRows.slice(i, i + INSERT_BATCH);
    const { data, error } = await supabase
      .from("bulk_message_recipients")
      .insert(chunk)
      .select("id, scheduled_at");
    if (error) {
      // Rollback parcial: deleta os já inseridos pra evitar half-populated.
      if (insertedIds.length > 0) {
        await supabase
          .from("bulk_message_recipients")
          .delete()
          .in("id", insertedIds.map((r) => r.id));
      }
      return {
        ok: false,
        populated: 0,
        state_created: 0,
        reason: `insert_failed:${error.message.slice(0, 200)}`,
      };
    }
    insertedIds.push(...((data || []) as { id: string; scheduled_at: string }[]));
  }

  // 8. Atualiza job.total_contacts.
  await supabase
    .from("bulk_message_jobs")
    .update({ total_contacts: insertedIds.length })
    .eq("id", jobId);

  // 9. Se sequência: cria sequence_state pra cada recipient. next_send_at =
  // scheduled_at do step 1 + step2.delay_days. State acompanha o avanço pra
  // step 2, step 3, ..., até último.
  let stateCreated = 0;
  if (isSequence) {
    const stateRows = insertedIds.map((r) => ({
      recipient_id: r.id,
      job_id: jobId,
      current_step: 1, // step 1 está enfileirado (pendiente em recipients)
      next_send_at: new Date(
        new Date(r.scheduled_at).getTime() + step2DelayDays * DAY_MS,
      ).toISOString(),
      status: "active" as const,
    }));
    for (let i = 0; i < stateRows.length; i += INSERT_BATCH) {
      const chunk = stateRows.slice(i, i + INSERT_BATCH);
      const { error } = await supabase
        .from("bulk_message_sequence_state")
        .insert(chunk);
      if (!error) stateCreated += chunk.length;
    }
  }

  return { ok: true, populated: insertedIds.length, state_created: stateCreated };
}
