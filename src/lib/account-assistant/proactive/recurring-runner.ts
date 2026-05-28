/**
 * Recurring campaigns runner (Etapa 4.5 — Pedro 2026-05-28).
 *
 * Pra cada recurring_campaigns row com enabled=true e next_run_at <= now:
 *   1. Cria um novo bulk_message_job filho com snapshot do filter_config +
 *      template + delivery_channel (em status='running' direto, populator
 *      é o próprio runner aqui).
 *   2. Popula recipients via Filter Engine. Se refresh_segment_on_run=false,
 *      poderia reusar lista da última run (não implementado — default true
 *      já cobre 95% dos casos).
 *   3. Atualiza last_run_at + computa próximo next_run_at via cron-evaluator
 *      no timezone do agente (D2: timezone do agente, não da agência).
 *
 * Flag-gate: RECURRING_CAMPAIGNS_ENABLED. Default OFF até admin ligar
 * conscientemente após smoke.
 *
 * Hard cap por execução: campaign.per_run_cap (default 1000, ceiling 50000).
 * Protege contra "filter solto pega 100k contatos".
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { executeContactsFilter } from "@/lib/account-assistant/filter-engine";
import type {
  ContactResult,
  FilterExpression,
  FilterExecutionContext,
} from "@/lib/account-assistant/filter-engine";
import { computeNextRunAt } from "./cron-evaluator";

const INSERT_BATCH = 500;
const MAX_PER_TICK = 5; // ≤5 campaigns por tick pra não estourar maxDuration

export interface RecurringTickResult {
  scanned: number;
  fired: number;
  skipped: number;
  errors: number;
}

interface RecurringRow {
  id: string;
  rep_id: string;
  location_id: string;
  agent_id: string;
  label: string;
  cron_expression: string;
  timezone: string;
  filter_config: Record<string, unknown>;
  message_template: string;
  delivery_channel: string;
  refresh_segment_on_run: boolean;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  per_run_cap: number;
}

export async function processRecurringTick(): Promise<RecurringTickResult> {
  if (process.env.RECURRING_CAMPAIGNS_ENABLED !== "1") {
    return { scanned: 0, fired: 0, skipped: 0, errors: 0 };
  }
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  const result: RecurringTickResult = { scanned: 0, fired: 0, skipped: 0, errors: 0 };

  // 1. Lista campaigns enabled+vencidas. ORDER pra processar mais atrasadas
  // primeiro (next_run_at ascending).
  const { data: rows, error: selErr } = await supabase
    .from("recurring_campaigns")
    .select(
      "id, rep_id, location_id, agent_id, label, cron_expression, timezone, filter_config, message_template, delivery_channel, refresh_segment_on_run, enabled, last_run_at, next_run_at, per_run_cap",
    )
    .eq("enabled", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(MAX_PER_TICK);
  if (selErr) {
    console.warn("[recurring-runner] SELECT falhou:", selErr.message);
    return { ...result, errors: 1 };
  }
  if (!rows || rows.length === 0) return result;

  result.scanned = rows.length;

  // 2. Pra cada, fire single campaign.
  for (const row of rows as RecurringRow[]) {
    try {
      const fired = await fireRecurringCampaign(row);
      if (fired === "fired") result.fired++;
      else if (fired === "skipped") result.skipped++;
      else if (fired === "failed") result.errors++;
    } catch (err) {
      result.errors++;
      console.warn(
        `[recurring-runner] campaign ${row.id} crashed:`,
        err instanceof Error ? err.message.slice(0, 200) : err,
      );
    }
  }

  return result;
}

type FireOutcome = "fired" | "skipped" | "failed";

async function fireRecurringCampaign(row: RecurringRow): Promise<FireOutcome> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Helper pra atualizar last_run_at + computar próximo next_run_at.
  // Se cron-evaluator não achar próximo (cron impossível), desabilita pra
  // não ficar batendo SELECT toda vez.
  const writeAfterRun = async (outcome: FireOutcome, jobId: string | null) => {
    const next = computeNextRunAt(row.cron_expression, row.timezone, new Date());
    const update: Record<string, unknown> = {
      last_run_at: nowIso,
      next_run_at: next?.toISOString() ?? null,
      updated_at: nowIso,
    };
    if (!next) {
      // Cron impossível ou ultrapassou lookahead — desabilita pra avisar admin.
      update.enabled = false;
    }
    await supabase
      .from("recurring_campaigns")
      .update(update)
      .eq("id", row.id);

    // Audit em outreach_runs (mesma tabela reusada — recurring é "outreach
    // programado"). Útil pra UI de histórico.
    await supabase.from("outreach_runs").insert({
      agent_id: row.agent_id,
      location_id: row.location_id,
      bulk_job_id: jobId,
      contacts_targeted: 0, // populator atualiza job.total_contacts depois
      contacts_enqueued: 0,
      status: outcome === "fired" ? "created" : outcome === "skipped" ? "skipped_no_contacts" : "failed",
    });
  };

  // 1. Resolve location pro company_id (GHL client). Sem isso não roda.
  const { data: location } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", row.location_id)
    .maybeSingle();
  if (!location?.company_id) {
    await writeAfterRun("failed", null);
    return "failed";
  }

  // 2. Executa Filter Engine (refresh = re-roda sempre por enquanto; futuro
  // pode reusar snapshot se refresh_segment_on_run=false).
  const ghlClient = new GHLClient(location.company_id, row.location_id);
  const filterCtx: FilterExecutionContext = {
    rep_id: row.rep_id,
    location_id: row.location_id,
    company_id: location.company_id,
    agent_id: row.agent_id,
    ghl_client: ghlClient,
    consumer_tool: "recurring_runner",
  };

  // Reusa o mesmo formato do campaign-populator: tag-based filter.
  const tag = (row.filter_config as { tag?: string })?.tag;
  if (!tag) {
    await writeAfterRun("failed", null);
    return "failed";
  }
  const filter: FilterExpression = {
    field: "tags",
    op: "contains",
    value: tag,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const filterResult = await executeContactsFilter(filter, filterCtx, {
    limit: Math.min(row.per_run_cap, 5000),
  });
  if (filterResult.status !== "ok") {
    await writeAfterRun("failed", null);
    return "failed";
  }
  const contacts: ContactResult[] = (filterResult.items || []).slice(0, row.per_run_cap);
  if (contacts.length === 0) {
    await writeAfterRun("skipped", null);
    return "skipped";
  }

  // 3. Cria bulk_message_job filho em status='running' (já dispara — diferente
  // do flow do /hub/campaigns que nasce paused). Recorrente é admin-aprovado
  // upfront (ele criou a regra), não precisa segundo OK.
  const childLabel = `${row.label} — ${nowIso.slice(0, 10)}`;
  const { data: job, error: jobErr } = await supabase
    .from("bulk_message_jobs")
    .insert({
      rep_id: row.rep_id,
      location_id: row.location_id,
      agent_id: row.agent_id,
      filter_config: row.filter_config,
      message_template: row.message_template,
      variation_mode: "none",
      interval_seconds: 90,
      jitter_seconds: 30,
      delivery_channel: row.delivery_channel,
      respect_quiet_hours: true,
      status: "running",
      label: childLabel,
      total_contacts: contacts.length,
      has_sequence: false,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    await writeAfterRun("failed", null);
    return "failed";
  }

  // 4. Popula recipients. Espalha com interval 90s + jitter 30s.
  const interval = 90;
  const jitter = 30;
  const baseStart = Date.now() + 5000;
  const recipientRows = contacts.map((c, i) => {
    const jitterMs = Math.floor(Math.random() * jitter * 1000);
    return {
      job_id: job.id,
      contact_id: c.id,
      contact_name: c.name,
      contact_phone: c.phone,
      scheduled_at: new Date(baseStart + i * interval * 1000 + jitterMs).toISOString(),
      status: "pending" as const,
      sequence_step: null,
    };
  });
  for (let i = 0; i < recipientRows.length; i += INSERT_BATCH) {
    const chunk = recipientRows.slice(i, i + INSERT_BATCH);
    await supabase.from("bulk_message_recipients").insert(chunk);
  }

  await writeAfterRun("fired", job.id);
  return "fired";
}
