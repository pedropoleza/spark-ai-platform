/**
 * GET /api/admin/dashboard — agregação geral pro dashboard admin.
 *
 * Pedro 2026-05-17: substitui /api/admin/signals como principal endpoint;
 * agrega KPIs, billing, features adoption, bulk, reps em 1 call.
 * Cache in-memory 60s pra não saturar DB (admin pode refresh seguro).
 *
 * Auth: middleware Basic Auth (env ADMIN_PANEL_PASSWORD).
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type CacheEntry = { at: number; data: unknown };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cached(key: string) {
  const e = cache.get(key);
  if (e && Date.now() - e.at < CACHE_TTL_MS) return e.data;
  return null;
}
function setCached(key: string, data: unknown) {
  cache.set(key, { at: Date.now(), data });
}

// ─────────────────────────────────────────────────────────────
// Helpers de agregação
// ─────────────────────────────────────────────────────────────

// Pedro 2026-05-21: o Overview agora aceita um RANGE de datas (filtro de data
// aplica no Overview inteiro). KPIs date-bound (mensagens, AI, reps ativos, bulk
// criados, taxa de resposta) re-escopam pro [startISO, endISO). Os snapshots
// (bulk running/paused, signals open, runner health) são "agora" e ignoram o range.
async function getOverview(startISO: string, endISO: string) {
  const supa = createAdminClient();

  const [
    repsTotalExt,
    aiCalls,
    bulkRunning,
    bulkPaused,
    bulkCreated,
    signalsHigh,
    signalsOpen,
    runnerHealth,
  ] = await Promise.all([
    supa.from("rep_identities").select("id", { count: "exact", head: true }).eq("is_internal", false),
    supa.from("usage_records").select("cost_usd, total_charge_usd").gte("created_at", startISO).lt("created_at", endISO),
    supa.from("bulk_message_jobs").select("id", { count: "exact", head: true }).eq("status", "running"),
    supa.from("bulk_message_jobs").select("id", { count: "exact", head: true }).eq("status", "paused"),
    supa.from("bulk_message_jobs").select("id", { count: "exact", head: true }).gte("created_at", startISO).lt("created_at", endISO),
    supa.from("admin_signals").select("id", { count: "exact", head: true }).eq("status", "open").eq("severity", "high"),
    supa.from("admin_signals").select("id", { count: "exact", head: true }).eq("status", "open"),
    supa.from("bulk_runner_health").select("last_tick_at, consecutive_errors, last_error").eq("id", 1).maybeSingle(),
  ]);

  // Mensagens no período: 1 fetch de (rep_id, role) → conta in/out E deriva o
  // engajamento por rep (reps alcançados pelo bot vs reps que responderam).
  // Cap defensivo 100k linhas (escala atual do SparkBot << isso). role só pode
  // ser 'user' (inbound do rep) ou 'agent' (outbound do bot) — CHECK constraint.
  let msgsIn = 0;
  let msgsOut = 0;
  const reachedReps = new Set<string>(); // reps com ≥1 msg do bot (role=agent)
  const respondedReps = new Set<string>(); // reps com ≥1 msg do rep (role=user)
  const activeReps = new Set<string>(); // reps com qualquer atividade no período
  try {
    const { data: msgRows } = await supa
      .from("sparkbot_messages")
      .select("rep_id, role")
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .limit(100000);
    for (const m of msgRows || []) {
      const rid = m.rep_id as string;
      activeReps.add(rid);
      if (m.role === "user") {
        msgsIn++;
        respondedReps.add(rid);
      } else if (m.role === "agent") {
        msgsOut++;
        reachedReps.add(rid);
      }
    }
  } catch {
    // best-effort — taxa de resposta vira 0 se o fetch falhar, não derruba o tab
  }

  // Taxa de resposta (Pedro 2026-05-21, opção "reps no geral"): dos reps que o
  // bot ALCANÇOU no período (mandou ≥1 msg), quantos RESPONDERAM (mandaram ≥1).
  // Cai quando proativos vão pro vácuo — é o sinal que o Pedro quer monitorar
  // ("ter quantos proativos quiser desde que a taxa de resposta se mantenha").
  let respondedAmongReached = 0;
  for (const rid of reachedReps) {
    if (respondedReps.has(rid)) respondedAmongReached++;
  }
  const responseRatePct =
    reachedReps.size > 0
      ? Math.round((respondedAmongReached / reachedReps.size) * 1000) / 10
      : 0;

  const sumCost = (aiCalls.data || []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const sumRevenue = (aiCalls.data || []).reduce((s, r) => s + Number(r.total_charge_usd ?? 0), 0);

  // Runner stale?
  const lastTickAt = runnerHealth.data?.last_tick_at;
  const tickAgeSec = lastTickAt ? Math.floor((Date.now() - new Date(lastTickAt).getTime()) / 1000) : null;
  const runnerStale = tickAgeSec !== null && tickAgeSec > 5 * 60;

  return {
    period: { from: startISO, to: endISO },
    reps: {
      active: activeReps.size,
      reached: reachedReps.size,
      responded: respondedAmongReached,
      total_external: repsTotalExt.count ?? 0,
    },
    response_rate: {
      pct: responseRatePct,
      responded: respondedAmongReached,
      reached: reachedReps.size,
    },
    messages: {
      total: msgsIn + msgsOut,
      inbound: msgsIn,
      outbound: msgsOut,
    },
    ai: {
      calls: (aiCalls.data || []).length,
      cost_usd: Math.round(sumCost * 10000) / 10000,
      revenue_usd: Math.round(sumRevenue * 10000) / 10000,
      margin_usd: Math.round((sumRevenue - sumCost) * 10000) / 10000,
      margin_pct: sumRevenue > 0 ? Math.round(((sumRevenue - sumCost) / sumRevenue) * 1000) / 10 : 0,
    },
    bulk: {
      running: bulkRunning.count ?? 0,
      paused: bulkPaused.count ?? 0,
      created: bulkCreated.count ?? 0,
    },
    signals: {
      open: signalsOpen.count ?? 0,
      high_open: signalsHigh.count ?? 0,
    },
    runner: {
      last_tick_at: lastTickAt,
      tick_age_seconds: tickAgeSec,
      consecutive_errors: runnerHealth.data?.consecutive_errors ?? 0,
      last_error: runnerHealth.data?.last_error ?? null,
      is_stale: runnerStale,
    },
  };
}

async function getBillingTab() {
  const supa = createAdminClient();
  const d14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Revenue por dia (últimos 14d)
  const { data: rows } = await supa
    .from("usage_records")
    .select("location_id, total_charge_usd, cost_usd, charged_to_wallet, cap_blocked, uses_custom_key, created_at, action_type")
    .gte("created_at", d14d);

  const byDay = new Map<string, { revenue: number; cost: number; calls: number }>();
  const byLocation = new Map<string, { revenue: number; cost: number; calls: number; charged: number; pending: number }>();
  let pendingTotal = 0;
  let pendingCount = 0;
  let chargedTotal = 0;

  for (const r of rows || []) {
    const day = (r.created_at as string).slice(0, 10);
    const dayEntry = byDay.get(day) || { revenue: 0, cost: 0, calls: 0 };
    dayEntry.revenue += Number(r.total_charge_usd ?? 0);
    dayEntry.cost += Number(r.cost_usd ?? 0);
    dayEntry.calls++;
    byDay.set(day, dayEntry);

    const locEntry = byLocation.get(r.location_id) || { revenue: 0, cost: 0, calls: 0, charged: 0, pending: 0 };
    locEntry.revenue += Number(r.total_charge_usd ?? 0);
    locEntry.cost += Number(r.cost_usd ?? 0);
    locEntry.calls++;
    if (r.charged_to_wallet) {
      locEntry.charged += Number(r.total_charge_usd ?? 0);
      chargedTotal += Number(r.total_charge_usd ?? 0);
    } else if (!r.uses_custom_key && !r.cap_blocked && Number(r.total_charge_usd) > 0) {
      locEntry.pending += Number(r.total_charge_usd ?? 0);
      pendingTotal += Number(r.total_charge_usd ?? 0);
      pendingCount++;
    }
    byLocation.set(r.location_id, locEntry);
  }

  return {
    daily: Array.from(byDay.entries())
      .sort()
      .map(([day, v]) => ({
        day,
        revenue: Math.round(v.revenue * 10000) / 10000,
        cost: Math.round(v.cost * 10000) / 10000,
        margin: Math.round((v.revenue - v.cost) * 10000) / 10000,
        calls: v.calls,
      })),
    top_locations: Array.from(byLocation.entries())
      .map(([loc, v]) => ({
        location_id: loc,
        revenue: Math.round(v.revenue * 10000) / 10000,
        cost: Math.round(v.cost * 10000) / 10000,
        calls: v.calls,
        charged: Math.round(v.charged * 10000) / 10000,
        pending: Math.round(v.pending * 10000) / 10000,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10),
    totals: {
      charged_14d: Math.round(chargedTotal * 100) / 100,
      pending_14d: Math.round(pendingTotal * 100) / 100,
      pending_count: pendingCount,
    },
  };
}

async function getFeaturesTab() {
  const supa = createAdminClient();
  const d7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: usage }, { data: bulkJobs }, { data: filters }, { data: proactive }] = await Promise.all([
    supa.from("usage_records").select("action_type, location_id, total_charge_usd").gte("created_at", d7d),
    supa.from("bulk_message_jobs").select("id, location_id, filter_config, status").gte("created_at", d7d),
    supa.from("filter_executions").select("id, location_id, consumer_tool").gte("created_at", d7d),
    supa.from("assistant_proactive_rules").select("rule_type, enabled"),
  ]);

  // Top action_types (= tools/operações)
  const byAction = new Map<string, { calls: number; locations: Set<string>; revenue: number }>();
  for (const u of usage || []) {
    const k = (u.action_type as string) || "unknown";
    const entry = byAction.get(k) || { calls: 0, locations: new Set(), revenue: 0 };
    entry.calls++;
    entry.locations.add(u.location_id);
    entry.revenue += Number(u.total_charge_usd ?? 0);
    byAction.set(k, entry);
  }

  // Filter Engine breakdown por consumer_tool
  const byFilterTool = new Map<string, { count: number; locations: Set<string> }>();
  for (const f of filters || []) {
    const k = (f.consumer_tool as string) || "unknown";
    const entry = byFilterTool.get(k) || { count: 0, locations: new Set() };
    entry.count++;
    entry.locations.add(f.location_id);
    byFilterTool.set(k, entry);
  }

  // Bulk adoption por location
  const bulkLocations = new Set<string>();
  let bulkMultiSegment = 0;
  for (const j of bulkJobs || []) {
    bulkLocations.add(j.location_id);
    const fc = j.filter_config as { type?: string } | null;
    if (fc?.type === "multi") bulkMultiSegment++;
  }

  // Proactive rules enabled
  const proactiveStats = new Map<string, { enabled: number; disabled: number }>();
  for (const r of proactive || []) {
    const k = (r.rule_type as string) || "unknown";
    const entry = proactiveStats.get(k) || { enabled: 0, disabled: 0 };
    if (r.enabled) entry.enabled++;
    else entry.disabled++;
    proactiveStats.set(k, entry);
  }

  return {
    top_actions: Array.from(byAction.entries())
      .map(([action, v]) => ({
        action,
        calls: v.calls,
        unique_locations: v.locations.size,
        revenue: Math.round(v.revenue * 10000) / 10000,
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 15),
    filter_engine: {
      total_executions: (filters || []).length,
      by_tool: Array.from(byFilterTool.entries())
        .map(([tool, v]) => ({
          tool,
          executions: v.count,
          unique_locations: v.locations.size,
        }))
        .sort((a, b) => b.executions - a.executions),
    },
    bulk_adoption: {
      total_jobs_7d: (bulkJobs || []).length,
      multi_segment_jobs: bulkMultiSegment,
      unique_locations: bulkLocations.size,
    },
    proactive_rules: Array.from(proactiveStats.entries()).map(([rule, v]) => ({
      rule,
      enabled: v.enabled,
      disabled: v.disabled,
    })),
  };
}

async function getBulkTab() {
  const supa = createAdminClient();
  const d7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: active }, { data: recent }, { data: health }] = await Promise.all([
    supa
      .from("bulk_message_jobs")
      .select(
        "id, label, status, total_contacts, sent_count, failed_count, location_id, rep_id, priority, created_at, estimated_completion_at, filter_config",
      )
      .in("status", ["running", "paused"])
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(50),
    supa
      .from("bulk_message_jobs")
      .select("id, label, status, total_contacts, sent_count, failed_count, location_id, created_at, completed_at")
      .in("status", ["completed", "cancelled", "failed"])
      .gte("created_at", d7d)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(20),
    supa.from("bulk_runner_health").select("*").eq("id", 1).maybeSingle(),
  ]);

  return {
    active_jobs: active || [],
    recent_completed: recent || [],
    runner_health: health.data,
  };
}

async function getFollowupsTab() {
  const supa = createAdminClient();
  const d7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const d30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: active }, { data: recent }, { data: stats7d }, { data: events7d }] = await Promise.all([
    supa
      .from("followup_sequences")
      .select(
        "id, rep_id, location_id, contact_name, contact_phone, goal, sequence_type, status, approval_status, spam_risk, spam_score, total_messages, sent_messages, failed_messages, skipped_messages, created_at, started_at",
      )
      .in("status", ["draft", "scheduled", "running", "paused"])
      .order("created_at", { ascending: false })
      .limit(50),
    supa
      .from("followup_sequences")
      .select(
        "id, contact_name, status, spam_risk, total_messages, sent_messages, cancelled_reason, completed_at, cancelled_at, created_at",
      )
      .in("status", ["completed", "cancelled", "skipped_reply", "failed"])
      .gte("created_at", d7d)
      .order("created_at", { ascending: false })
      .limit(20),
    supa
      .from("followup_sequences")
      .select("status, spam_risk, approval_status, sequence_type")
      .gte("created_at", d30d),
    supa
      .from("followup_events")
      .select("event_type, created_at")
      .gte("created_at", d7d)
      .limit(500),
  ]);

  // Funnel breakdown
  const byStatus = new Map<string, number>();
  const byRisk = new Map<string, number>();
  const byApproval = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const s of stats7d || []) {
    byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
    if (s.spam_risk) byRisk.set(s.spam_risk, (byRisk.get(s.spam_risk) ?? 0) + 1);
    if (s.approval_status) byApproval.set(s.approval_status, (byApproval.get(s.approval_status) ?? 0) + 1);
    if (s.sequence_type) byType.set(s.sequence_type, (byType.get(s.sequence_type) ?? 0) + 1);
  }

  // Events 7d
  const eventCounts = new Map<string, number>();
  for (const e of events7d || []) {
    eventCounts.set(e.event_type, (eventCounts.get(e.event_type) ?? 0) + 1);
  }

  return {
    active_sequences: active || [],
    recent_completed: recent || [],
    stats_30d: {
      total: (stats7d || []).length,
      by_status: Object.fromEntries(byStatus),
      by_risk: Object.fromEntries(byRisk),
      by_approval: Object.fromEntries(byApproval),
      by_type: Object.fromEntries(byType),
    },
    events_7d: Object.fromEntries(eventCounts),
  };
}

async function getRepsTab() {
  const supa = createAdminClient();
  const { data: reps } = await supa
    .from("rep_identities")
    .select("id, phone, name, active_location_id, is_internal, role, last_inbound_at, created_at")
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(200);

  // Hidrata location names
  const locIds = Array.from(new Set((reps || []).map((r) => r.active_location_id).filter(Boolean)));
  const { data: locations } = await supa
    .from("locations")
    .select("location_id, location_name, timezone")
    .in("location_id", locIds.length > 0 ? locIds : ["__none__"]);
  const locMap = new Map((locations || []).map((l) => [l.location_id, l]));

  return {
    reps: (reps || []).map((r) => {
      const loc = locMap.get(r.active_location_id);
      return {
        ...r,
        location_name: loc?.location_name || null,
        location_timezone: loc?.timezone || null,
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tab = url.searchParams.get("tab") || "all";
  const fresh = url.searchParams.get("fresh") === "1";

  // Date range pro Overview (Pedro 2026-05-21). Default: últimos 7 dias.
  // Clamp defensivo: from < to, range mín 1h, máx 92 dias (evita scan gigante
  // + fetch de mensagens estourar o cap de 100k). Datas inválidas → default.
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");
  let endMs = toParam ? Date.parse(toParam) : now;
  let startMs = fromParam ? Date.parse(fromParam) : now - 7 * DAY_MS;
  if (!Number.isFinite(endMs)) endMs = now;
  if (!Number.isFinite(startMs)) startMs = now - 7 * DAY_MS;
  if (startMs >= endMs) startMs = endMs - DAY_MS; // garante range positivo
  if (endMs - startMs < 60 * 60 * 1000) startMs = endMs - 60 * 60 * 1000; // mín 1h
  if (endMs - startMs > 92 * DAY_MS) startMs = endMs - 92 * DAY_MS; // máx 92d
  // Snap pro minuto: presets usam to=now(), que mudaria o cache key a cada ms e
  // mataria o cache de 60s. Quantizar pro minuto faz loads dentro do mesmo
  // minuto compartilharem cache (perda ≤59s de dados — irrelevante p/ agregado).
  const MIN_MS = 60 * 1000;
  startMs = Math.floor(startMs / MIN_MS) * MIN_MS;
  endMs = Math.floor(endMs / MIN_MS) * MIN_MS;
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();

  // Range no cache key só importa pro overview (único date-bound por range);
  // os outros tabs ignoram, mas incluir é inofensivo (só mais entradas de cache).
  const cacheKey = `dash:${tab}:${startISO}:${endISO}`;
  if (!fresh) {
    const c = cached(cacheKey);
    if (c) {
      return NextResponse.json({ ok: true, cached: true, ...(c as object) });
    }
  }

  try {
    const payload: Record<string, unknown> = {};
    if (tab === "overview" || tab === "all") {
      payload.overview = await getOverview(startISO, endISO);
    }
    if (tab === "billing" || tab === "all") {
      payload.billing = await getBillingTab();
    }
    if (tab === "features" || tab === "all") {
      payload.features = await getFeaturesTab();
    }
    if (tab === "bulk" || tab === "all") {
      payload.bulk = await getBulkTab();
    }
    if (tab === "reps" || tab === "all") {
      payload.reps = await getRepsTab();
    }
    if (tab === "followups" || tab === "all") {
      payload.followups = await getFollowupsTab();
    }

    setCached(cacheKey, payload);
    return NextResponse.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/dashboard] FAIL:", msg);
    // Sweep F49 2026-06-05: admin perde visão do painel (só admin, não user-facing).
    reportError({ title: "Admin dashboard: crash", feature: "admin-dashboard", severity: "medium", error: err });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
