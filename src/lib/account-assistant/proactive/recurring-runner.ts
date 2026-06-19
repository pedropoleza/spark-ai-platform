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
import { reportError } from "@/lib/admin-signals/report-error";
import { GHLClient } from "@/lib/ghl/client";
import { executeContactsFilter } from "@/lib/account-assistant/filter-engine";
import type {
  ContactResult,
  FilterExpression,
  FilterExecutionContext,
} from "@/lib/account-assistant/filter-engine";
import { computeNextRunAt } from "./cron-evaluator";
import { evalQuietHours, type QuietHoursConfig } from "./quiet-hours";
// F60 (Pedro 2026-06-10): mesmo enforcement de cap diário do campaign-populator,
// inline aqui (recorrente popula recipients ele mesmo, não passa pelo populator).
import { getDailyCap, buildCappedScheduledAts } from "@/lib/account-assistant/tools/bulk-messages";
// Group campaigns (00113): recorrência de grupo posta nos group_targets via Stevo.
import { computeBatchedScheduledAts } from "@/lib/account-assistant/tools/bulk-delivery-strategy";
import {
  GROUP_INTERVAL_SECONDS_DEFAULT,
  GROUP_JITTER_SECONDS_DEFAULT,
} from "@/lib/account-assistant/group-campaigns/config";

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
  // Group campaigns (00113): 'groups' posta nos group_targets em vez de filtrar contatos.
  target_type?: "contacts" | "groups" | null;
  group_targets?: Array<{ jid: string; name: string }> | null;
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
      "id, rep_id, location_id, agent_id, label, cron_expression, timezone, filter_config, message_template, delivery_channel, refresh_segment_on_run, enabled, last_run_at, next_run_at, per_run_cap, target_type, group_targets",
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
      // Sweep F49 2026-06-05: campanha recorrente não disparou neste tick.
      reportError({ title: "Recurring runner: campanha crashou", feature: "proactive-recurring", severity: "medium", error: err, metadata: { campaignId: row.id } });
    }
  }

  return result;
}

type FireOutcome = "fired" | "skipped" | "failed";

/**
 * Etapa 4.6: helper extraído pra rodar Filter Engine quando refresh
 * é true (default) ou quando refresh=false mas é a primeira execução.
 */
async function fetchViaFilter(
  row: RecurringRow,
  companyId: string,
  tag: string,
): Promise<{ id: string; name: string | null; phone: string | null }[]> {
  const ghlClient = new GHLClient(companyId, row.location_id);
  const filterCtx: FilterExecutionContext = {
    rep_id: row.rep_id,
    location_id: row.location_id,
    company_id: companyId,
    agent_id: row.agent_id,
    ghl_client: ghlClient,
    consumer_tool: "recurring_runner",
  };
  const filter: FilterExpression = {
    field: "tags",
    op: "contains",
    value: tag,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const filterResult = await executeContactsFilter(filter, filterCtx, {
    limit: Math.min(row.per_run_cap, 5000),
  });
  if (filterResult.status !== "ok") return [];
  return ((filterResult.items as ContactResult[]) || []).map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
  }));
}

async function fireRecurringCampaign(row: RecurringRow): Promise<FireOutcome> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Helper pra atualizar last_run_at + computar próximo next_run_at.
  // Se cron-evaluator não achar próximo (cron impossível), desabilita pra
  // não ficar batendo SELECT toda vez.
  const writeAfterRun = async (
    outcome: FireOutcome,
    jobId: string | null,
    auditStatus?: "created" | "skipped_no_contacts" | "skipped_outside_hours" | "failed",
  ) => {
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
    const finalStatus = auditStatus
      ? auditStatus
      : outcome === "fired"
      ? "created"
      : outcome === "skipped"
      ? "skipped_no_contacts"
      : "failed";
    await supabase.from("outreach_runs").insert({
      agent_id: row.agent_id,
      location_id: row.location_id,
      bulk_job_id: jobId,
      contacts_targeted: 0, // populator atualiza job.total_contacts depois
      contacts_enqueued: 0,
      status: finalStatus,
    });
  };

  // F14 (Pedro 2026-05-28): respeita quiet_hours do agente. Se cron caiu
  // durante janela noturna (ex: rep configurou 22-7 e cron é "0 23 * * *"),
  // skip esse tick — next_run_at avança via cron-evaluator pro próximo
  // disparo válido. Não loga 'failed' (não é erro, é design).
  const { data: cfg } = await supabase
    .from("agent_configs")
    .select("quiet_hours")
    .eq("agent_id", row.agent_id)
    .maybeSingle();
  const qh = (cfg?.quiet_hours as QuietHoursConfig | null) || null;
  // Fix P2 review 2026-06-18: quiet_hours NÃO se aplica a campanha de grupo — o
  // rep escolheu o horário explícito (ex.: 7:30) e o one-shot de grupo já nasce
  // com respect_quiet_hours:false. Senão o post diário sumiria sem o rep entender.
  if (row.target_type !== "groups" && qh?.enabled && evalQuietHours(qh)) {
    await writeAfterRun("skipped", null, "skipped_outside_hours");
    return "skipped";
  }

  // Group campaigns (00113): posta nos group_targets via Stevo (não filtra
  // contatos, não precisa de company_id/GHL). Cada ocorrência = job filho NOVO →
  // o mesmo grupo reaparece dia após dia sem colidir com UNIQUE(job_id,contact_id).
  // Variação anti-ban via variation_mode='light' (o runner varia por grupo no send).
  if (row.target_type === "groups") {
    const targets = Array.isArray(row.group_targets) ? row.group_targets : [];
    if (targets.length === 0) {
      await writeAfterRun("skipped", null);
      return "skipped";
    }
    const groups = targets.slice(0, row.per_run_cap);
    const scheduledAts = computeBatchedScheduledAts({
      total_recipients: groups.length,
      strategy: {
        type: "today",
        interval_seconds: GROUP_INTERVAL_SECONDS_DEFAULT,
        jitter_seconds: GROUP_JITTER_SECONDS_DEFAULT,
      },
      base_start: new Date(Date.now() + 5000),
      daily_cap: 100000,
    });
    const childLabel = `${row.label} — ${nowIso.slice(0, 10)}`;
    const { data: gJob, error: gJobErr } = await supabase
      .from("bulk_message_jobs")
      .insert({
        rep_id: row.rep_id,
        location_id: row.location_id,
        agent_id: row.agent_id,
        filter_config: row.filter_config,
        message_template: row.message_template,
        variation_mode: "light",
        interval_seconds: GROUP_INTERVAL_SECONDS_DEFAULT,
        jitter_seconds: GROUP_JITTER_SECONDS_DEFAULT,
        delivery_channel: "whatsapp_web_sms",
        target_type: "groups",
        respect_quiet_hours: false,
        status: "running",
        label: childLabel,
        total_contacts: groups.length,
        has_sequence: false,
      })
      .select("id")
      .single();
    if (gJobErr || !gJob) {
      await writeAfterRun("failed", null);
      return "failed";
    }
    const gRows = groups.map((g, i) => ({
      job_id: gJob.id,
      contact_id: g.jid,
      contact_name: g.name,
      contact_phone: null,
      target_jid: g.jid,
      group_name: g.name,
      scheduled_at: scheduledAts[i].toISOString(),
      status: "pending" as const,
      sequence_step: null,
    }));
    for (let i = 0; i < gRows.length; i += INSERT_BATCH) {
      const { error: recErr } = await supabase
        .from("bulk_message_recipients")
        .insert(gRows.slice(i, i + INSERT_BATCH));
      if (recErr) {
        // supabase-js não lança — checa o erro. Sem isso, reportaria 'fired' com 0
        // recipients (job running mudo). Marca o job failed e reporta failed.
        await supabase
          .from("bulk_message_jobs")
          .update({ status: "failed", cancelled_reason: `group recipients insert: ${recErr.message.slice(0, 200)}` })
          .eq("id", gJob.id);
        await writeAfterRun("failed", gJob.id);
        return "failed";
      }
    }
    await writeAfterRun("fired", gJob.id);
    return "fired";
  }

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

  // 2. Resolve lista de contatos. Etapa 4.6: respeita refresh_segment_on_run.
  //   - true (default): re-executa Filter Engine fresh (novos contatos entram,
  //     removidos não recebem).
  //   - false: tenta reusar contact_ids da última execução (snapshot fixo);
  //     se não houver execução anterior, cai pro refresh inicial.
  type SnapshotContact = { id: string; name: string | null; phone: string | null };
  let contacts: SnapshotContact[];
  const tag = (row.filter_config as { tag?: string })?.tag;
  if (!tag) {
    await writeAfterRun("failed", null);
    return "failed";
  }

  if (!row.refresh_segment_on_run) {
    // Snapshot reuse: pega contact_ids do último bulk_job filho dessa recurring.
    const { data: lastRun } = await supabase
      .from("outreach_runs")
      .select("bulk_job_id")
      .eq("agent_id", row.agent_id)
      .eq("location_id", row.location_id)
      .eq("status", "created")
      .not("bulk_job_id", "is", null)
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastRun?.bulk_job_id) {
      const { data: lastRecipients } = await supabase
        .from("bulk_message_recipients")
        .select("contact_id, contact_name, contact_phone")
        .eq("job_id", lastRun.bulk_job_id)
        .limit(row.per_run_cap);
      const distinct = new Map<string, SnapshotContact>();
      for (const r of (lastRecipients || []) as Array<{
        contact_id: string;
        contact_name: string | null;
        contact_phone: string | null;
      }>) {
        if (!distinct.has(r.contact_id)) {
          distinct.set(r.contact_id, {
            id: r.contact_id,
            name: r.contact_name,
            phone: r.contact_phone,
          });
        }
      }
      contacts = Array.from(distinct.values());
    } else {
      // Sem execução anterior — refresh inicial.
      contacts = await fetchViaFilter(row, location.company_id, tag);
    }
  } else {
    contacts = await fetchViaFilter(row, location.company_id, tag);
  }

  if (contacts.length === 0) {
    await writeAfterRun("skipped", null);
    return "skipped";
  }
  contacts = contacts.slice(0, row.per_run_cap);

  // 3. Cria bulk_message_job filho em status='running' (já dispara — diferente
  // do flow do /hub/campaigns que nasce paused). Recorrente é admin-aprovado
  // upfront (ele criou a regra), não precisa segundo OK.
  // F60 (Pedro 2026-06-10): snapshot do teto diário (daily_bulk_message_cap).
  const dailyCap = await getDailyCap(row.agent_id);
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
      daily_cap: dailyCap,
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

  // 4. Popula recipients. Espalha com interval 90s + jitter 30s, respeitando o
  // teto por dia-ET (F60): ≤ daily_cap recipients/dia, overflow rola pro próximo
  // dia. Sem cap (null) = linear histórico. Seed de "já agendado hoje" via
  // countRecipientsLast24h dentro do helper.
  const interval = 90;
  const jitter = 30;
  const baseStart = new Date(Date.now() + 5000);
  const scheduledAts = await buildCappedScheduledAts({
    locationId: row.location_id,
    count: contacts.length,
    dailyCap,
    intervalSeconds: interval,
    jitterSeconds: jitter,
    baseStart,
  });
  const recipientRows = contacts.map((c, i) => {
    return {
      job_id: job.id,
      contact_id: c.id,
      contact_name: c.name,
      contact_phone: c.phone,
      scheduled_at: scheduledAts[i].toISOString(),
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
