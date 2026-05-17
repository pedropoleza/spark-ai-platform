/**
 * SMOKE TEST H32 — Bulk Management Platform (Fases 1-5).
 *
 * Roda HANDLERS reais das tools + helpers de suporte (não chama LLM),
 * validando cada feature ponta a ponta. Setup limpa estado antes E depois.
 *
 * Cobertura (40+ asserts, agrupados A-L):
 *   A — Fase 1: countRecipientsLast24h windowDate
 *   B — Fase 1: formatDisclaimersChecklist
 *   C — Fase 1: bulk_runner_health + view + healthCheck
 *   D — Fase 2: management tools (dashboard, pause, resume, cancel, override)
 *   E — Fase 2: schedule_v2 + label/priority + reschedule + edit
 *   F — Fase 3: smart cap (default, effective, weekly, last7d)
 *   G — Fase 3: per-contact cooldown
 *   H — Fase 4: anti-duplicação (findSimilarActiveJobs)
 *   I — Fase 5: loop detection (turn-context)
 *   J — Fase 5: bulk_session_state auto-register
 *   K — Fase 5: silence recovery
 *   L — V1 deprecation (descriptions)
 *
 * Run:
 *   npx tsx -r tsconfig-paths/register scripts/smoke-test-h32.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { TOOL_REGISTRY } from "@/lib/account-assistant/tools";
import type { ToolContext } from "@/lib/account-assistant/tools/types";
import type { RepIdentity, ToolResult } from "@/types/account-assistant";

import {
  countRecipientsLast24h,
  countRecipientsLast7Days,
  getDailyCap,
  getEffectiveDailyCap,
  getWeeklyCap,
  getContactsWithRecentBulk,
  recordContactBulkSent,
  findSimilarActiveJobs,
  resolveAgentId,
  DEFAULT_DAILY_BULK_CAP,
} from "@/lib/account-assistant/tools/bulk-messages";
import { formatDisclaimersChecklist } from "@/lib/account-assistant/filter-engine/disclaimers";
import type { Disclaimer } from "@/lib/account-assistant/filter-engine/disclaimers";
import { checkBulkRunnerStaleAndAlert } from "@/lib/account-assistant/proactive/bulk-runner-health-check";
import {
  createTurnContext,
  recordQuestion,
  questionCount,
  recordBulkChoice,
  autoRegisterFromToolResult,
  renderTurnContextForPrompt,
} from "@/lib/account-assistant/conversational/turn-context";
import {
  detectSilenceGap,
  renderSilenceRecoveryForPrompt,
} from "@/lib/account-assistant/conversational/silence-recovery";

const LOC = "H09HtG22LZzTU8htMxxg";
const PEDRO_PHONE = "+17867717077";

type TestResult = {
  group: string;
  name: string;
  passed: boolean;
  detail: string;
  duration_ms: number;
  error?: string;
};

const results: TestResult[] = [];

function record(group: string, name: string, passed: boolean, detail: string, dur: number, error?: string) {
  results.push({ group, name, passed, detail, duration_ms: dur, error });
  const icon = passed ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${name} (${dur}ms) ${detail ? "— " + detail : ""}`);
  if (!passed && error) console.log(`         ERR: ${error}`);
}

async function run(group: string, name: string, fn: () => Promise<{ passed: boolean; detail: string }>) {
  const t = Date.now();
  try {
    const { passed, detail } = await fn();
    record(group, name, passed, detail, Date.now() - t);
  } catch (e) {
    const err = e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(0, 4).join("\n")}` : String(e);
    record(group, name, false, "EXCEPTION", Date.now() - t, err);
  }
}

async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOL_REGISTRY[name];
  if (!tool) throw new Error(`Tool ${name} não encontrada`);
  return tool.handler(ctx, args);
}

// =========================================================================
// MAIN
// =========================================================================

async function main() {
  console.log("\n=== SMOKE TEST H32 — Bulk Management Platform (Fases 1-5) ===");
  console.log(`Location: ${LOC} | Rep: ${PEDRO_PHONE}`);
  console.log(`Now: ${new Date().toISOString()}\n`);

  const supa = createAdminClient();

  // ---- Setup
  const { data: loc } = await supa
    .from("locations")
    .select("company_id, location_name, timezone")
    .eq("location_id", LOC)
    .single();
  if (!loc) throw new Error("location não sincronizada");

  const { data: repRaw } = await supa
    .from("rep_identities")
    .select("*")
    .eq("phone", PEDRO_PHONE)
    .single();
  if (!repRaw) throw new Error("rep Pedro não encontrado no DB");
  const rep = repRaw as unknown as RepIdentity;

  const ghl = new GHLClient(loc.company_id, LOC);
  const ctx: ToolContext = {
    rep,
    locationId: LOC,
    companyId: loc.company_id,
    ghlClient: ghl,
    confirmationMode: "high_only",
    testSessionId: null,
  };

  const agentId = await resolveAgentId(LOC);
  console.log(`Rep ID: ${rep.id} | agent: ${agentId}`);

  // ---- Pre-cleanup: cancela jobs ativos do Pedro
  console.log("\n[SETUP] Pre-cleanup — cancela qualquer job ativo do Pedro");
  const preCancel = await callTool(ctx, "bulk_cancel_all", {
    confirmed_by_rep: true,
    reason: "smoke test pre-cleanup",
  });
  if (preCancel.status === "ok") {
    const d = preCancel.data as { cancelled_count: number };
    console.log(`  Pre-cancelled: ${d.cancelled_count} job(s)`);
  } else {
    console.log(`  Pre-cleanup falhou (não fatal): ${JSON.stringify(preCancel).slice(0, 150)}`);
  }

  // Limpa cooldowns/overrides de testes anteriores
  await supa.from("bulk_cap_overrides").delete().eq("rep_identity_id", rep.id).like("reason", "smoke%");

  // =====================================================================
  // A) FASE 1 — countRecipientsLast24h cap futuro corrigido
  // =====================================================================
  console.log("\n[A] FASE 1 — countRecipientsLast24h windowDate");

  await run("A", "A1 countRecipientsLast24h() sem windowDate", async () => {
    const count = await countRecipientsLast24h(LOC);
    return { passed: typeof count === "number" && count >= 0, detail: `count_hoje=${count}` };
  });

  await run("A", "A2 countRecipientsLast24h(futureDate 2026-06-01)", async () => {
    const future = new Date("2026-06-01T12:00:00Z");
    const count = await countRecipientsLast24h(LOC, future);
    return { passed: count === 0, detail: `count_01jun=${count} (esperado 0 sem jobs futuros)` };
  });

  await run("A", "A3 cap dia 19/05 independe de cap hoje", async () => {
    const cHoje = await countRecipientsLast24h(LOC);
    const c19 = await countRecipientsLast24h(LOC, new Date("2026-05-19T12:00:00-04:00"));
    return {
      passed: typeof c19 === "number" && typeof cHoje === "number",
      detail: `hoje=${cHoje} | 19/05=${c19} (queries independentes ok)`,
    };
  });

  // =====================================================================
  // B) FASE 1 — formatDisclaimersChecklist
  // =====================================================================
  console.log("\n[B] FASE 1 — formatDisclaimersChecklist");

  await run("B", "B1 2 disclaimers → checklist com header", async () => {
    const fake: Disclaimer[] = [
      { key: "lista_quente_required", severity: "critical", required_flag: "confirmed_warm_list", text: "x" },
      { key: "risk_high_volume_warm", severity: "warn", required_flag: "confirmed_risk_volume", text: "y" },
    ];
    const out = formatDisclaimersChecklist(fake);
    const hasHeader = /Antes de confirmar, preciso de OK em 2 pontos/.test(out);
    const hasBullets = (out.match(/☐/g) || []).length === 2;
    return {
      passed: hasHeader && hasBullets,
      detail: `header=${hasHeader} bullets=${(out.match(/☐/g) || []).length}`,
    };
  });

  await run("B", "B2 1 disclaimer → texto direto sem checklist", async () => {
    const fake: Disclaimer[] = [
      { key: "lista_quente_required", severity: "critical", required_flag: "confirmed_warm_list", text: "single" },
    ];
    const out = formatDisclaimersChecklist(fake);
    return {
      passed: out === "single",
      detail: `out=${JSON.stringify(out).slice(0, 60)}`,
    };
  });

  await run("B", "B3 0 disclaimers → string vazia", async () => {
    const out = formatDisclaimersChecklist([]);
    return { passed: out === "", detail: `out_len=${out.length}` };
  });

  // =====================================================================
  // C) FASE 1 — Runner health
  // =====================================================================
  console.log("\n[C] FASE 1 — Runner health");

  await run("C", "C1 bulk_runner_health row id=1 existe", async () => {
    const { data } = await supa.from("bulk_runner_health").select("*").eq("id", 1).maybeSingle();
    return { passed: !!data, detail: data ? `last_tick=${data.last_tick_at}` : "missing" };
  });

  await run("C", "C2 view bulk_runner_stale_v retorna is_stale boolean", async () => {
    const { data } = await supa.from("bulk_runner_stale_v").select("is_stale, seconds_since_last_tick").eq("id", 1).maybeSingle();
    return {
      passed: !!data && typeof data.is_stale === "boolean",
      detail: data ? `is_stale=${data.is_stale} seconds=${data.seconds_since_last_tick}` : "view sem row",
    };
  });

  await run("C", "C3 checkBulkRunnerStaleAndAlert() retorna shape esperado", async () => {
    const r = await checkBulkRunnerStaleAndAlert();
    const shapeOk =
      typeof r.runner_stale === "boolean" &&
      typeof r.stalled_jobs_count === "number" &&
      typeof r.alerts_created === "number";
    return {
      passed: shapeOk,
      detail: `runner_stale=${r.runner_stale} stalled=${r.stalled_jobs_count} alerts=${r.alerts_created} reps_notified=${r.reps_notified}`,
    };
  });

  // =====================================================================
  // D) FASE 2 — Management tools (sem jobs)
  // =====================================================================
  console.log("\n[D] FASE 2 — Management tools");

  await run("D", "D1 bulk_dashboard sem jobs", async () => {
    const r = await callTool(ctx, "bulk_dashboard", {});
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status}` };
    const d = r.data as { active_jobs: unknown[]; cap_status: unknown[]; dashboard_summary: string };
    const aoOk = Array.isArray(d.active_jobs) && d.active_jobs.length === 0;
    const capOk = Array.isArray(d.cap_status) && d.cap_status.length === 3;
    const summaryOk = /Nenhum disparo ativo/.test(d.dashboard_summary);
    return {
      passed: aoOk && capOk && summaryOk,
      detail: `active=${d.active_jobs.length} cap_days=${d.cap_status.length} no_active_msg=${summaryOk}`,
    };
  });

  await run("D", "D2 bulk_pause_all sem running", async () => {
    const r = await callTool(ctx, "bulk_pause_all", { confirmed_by_rep: true });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status}` };
    const d = r.data as { paused_count: number };
    return { passed: d.paused_count === 0, detail: `paused_count=${d.paused_count}` };
  });

  await run("D", "D3 bulk_resume_all sem paused", async () => {
    const r = await callTool(ctx, "bulk_resume_all", { confirmed_by_rep: true });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status}` };
    const d = r.data as { resumed_count: number };
    return { passed: d.resumed_count === 0, detail: `resumed_count=${d.resumed_count}` };
  });

  await run("D", "D4 bulk_cancel_all sem ativos", async () => {
    const r = await callTool(ctx, "bulk_cancel_all", { confirmed_by_rep: true });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status}` };
    const d = r.data as { cancelled_count: number };
    return { passed: d.cancelled_count === 0, detail: `cancelled_count=${d.cancelled_count}` };
  });

  // D5 — override criar
  let createdOverrideId: string | null = null;
  await run("D", "D5 bulk_request_cap_override +50 today (audit row)", async () => {
    const baseCap = await getDailyCap(agentId);
    const before = await getEffectiveDailyCap(LOC, baseCap, new Date());
    const r = await callTool(ctx, "bulk_request_cap_override", {
      extra_count: 50,
      reason: "smoke test D5",
      confirmed_by_rep: true,
    });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 80)}` };
    const d = r.data as { override_id: string; cap_after: number; cap_before: number; extra_granted: number };
    createdOverrideId = d.override_id;
    const after = await getEffectiveDailyCap(LOC, baseCap, new Date());
    const matches = baseCap !== null && after !== null && after === (before ?? 0) + 50;
    return {
      passed: !!createdOverrideId && d.extra_granted === 50 && matches,
      detail: `base=${baseCap} before=${before} after=${after} extra=${d.extra_granted} id=${d.override_id?.slice(0, 8)}`,
    };
  });

  await run("D", "D6 bulk_request_cap_override 9999 → hard ceiling 3x", async () => {
    const r = await callTool(ctx, "bulk_request_cap_override", {
      extra_count: 9999,
      reason: "smoke test D6 hard ceiling",
      confirmed_by_rep: true,
    });
    const msg = (r as { message?: string }).message || "";
    const ceilingError = r.status === "error" && /ceiling|teto|máximo|maximo|3x/i.test(msg);
    return { passed: ceilingError, detail: `status=${r.status} msg="${msg.slice(0, 120)}"` };
  });

  await run("D", "D7 cleanup override row D5", async () => {
    if (!createdOverrideId) return { passed: true, detail: "skip (no override created)" };
    const { error } = await supa.from("bulk_cap_overrides").delete().eq("id", createdOverrideId);
    return { passed: !error, detail: error ? error.message : `deleted ${createdOverrideId.slice(0, 8)}` };
  });

  // =====================================================================
  // E) FASE 2 — Schedule com label/priority (fluxo completo)
  // =====================================================================
  console.log("\n[E] FASE 2 — Schedule label/priority + flow");

  // Pega 1 contato Pedro pra evitar contatos reais não-controlados.
  // Estratégia: filter MUITO restritivo — usa email/phone do próprio Pedro
  // (se rep tem ghl_contact_id no DB) OU 1 tag improvável.
  // Pra schedule_bulk_message_v2 idealmente queremos N=1 contato.
  // Tentamos via search_contacts buscando pelo email/phone do rep.

  // Vamos usar o filter direto: tags contains __smoketest_unlikely_tag__
  // Se 0 contatos → schedule retorna not_found, validamos errado.
  // Por isso usamos uma fallback strategy: query name = "Pedro" + limit 1.
  let testContactId: string | null = null;
  let testContactEmail: string | null = null;
  let testContactPhone: string | null = null;
  {
    const sr = await callTool(ctx, "search_contacts", { query: "Pedro Poleza", limit: 1 });
    if (sr.status === "ok") {
      const d = sr.data as { contacts: Array<{ id: string; name: string; email?: string; phone?: string }> };
      if (d.contacts && d.contacts.length > 0) {
        testContactId = d.contacts[0].id;
        testContactEmail = d.contacts[0].email || null;
        testContactPhone = d.contacts[0].phone || null;
        console.log(`  Test contact: ${d.contacts[0].name} (${testContactId?.slice(0, 8)}) email=${testContactEmail} phone=${testContactPhone}`);
      }
    }
  }

  // Filter restritivo: tenta email > phone > fallback fullName
  // (Filter engine NÃO aceita field 'id' — só campos GHL contact standard)
  const buildSingleContactFilter = () => {
    if (testContactEmail) return { field: "email", op: "eq", value: testContactEmail };
    if (testContactPhone) return { field: "phone", op: "eq", value: testContactPhone };
    return { field: "fullName", op: "contains", value: "Pedro Poleza" };
  };

  let scheduledJobId: string | null = null;

  // E1 — preview com filter retornando 1-2 contatos
  await run("E", "E1 preview_bulk_message_v2 retorna delivery_options + disclaimers + coexistence + cooldown + weekly_cap + similar", async () => {
    const filterByName = buildSingleContactFilter();
    const r = await callTool(ctx, "preview_bulk_message_v2", {
      segments: [
        {
          label: "smoke test seg",
          filter: filterByName,
          message_template: "Olá {first_name}, smoke test E1 — ignorar.",
        },
      ],
      list_temperature: "warm",
    });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 100)}` };
    const d = r.data as {
      total_contacts: number;
      delivery_options: unknown[];
      disclaimers: unknown[];
      disclaimers_for_whatsapp: string;
      coexistence: unknown;
      cooldown_warnings: unknown[];
      weekly_cap: number | null;
      similar_active_jobs: unknown[];
    };
    const has = {
      delivery: Array.isArray(d.delivery_options),
      discKey: typeof d.disclaimers_for_whatsapp === "string",
      cooldown: Array.isArray(d.cooldown_warnings),
      coexHas: "coexistence" in d,
      similar: Array.isArray(d.similar_active_jobs),
      weekly: "weekly_cap" in d,
    };
    const allOk = Object.values(has).every(Boolean);
    return {
      passed: allOk,
      detail: `total=${d.total_contacts} delivery=${d.delivery_options?.length} disc=${d.disclaimers?.length} weekly_cap=${d.weekly_cap} similar=${d.similar_active_jobs?.length} shape=${JSON.stringify(has)}`,
    };
  });

  // E2 — schedule
  await run("E", "E2 schedule_bulk_message_v2 com label/priority", async () => {
    if (!testContactId) return { passed: false, detail: "sem contato pra testar (search_contacts não achou Pedro)" };
    const r = await callTool(ctx, "schedule_bulk_message_v2", {
      segments: [
        {
          label: "smoke test seg",
          filter: buildSingleContactFilter(),
          message_template: "Smoke test E2 — não responder.",
        },
      ],
      list_temperature: "warm",
      label: "smoke test E2",
      priority: 80,
      confirmed_by_rep: true,
      confirmed_warm_list: true,
      start_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // amanhã (não dispara durante teste)
      delivery_strategy: { type: "today" },
    });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 200)}` };
    const d = r.data as { job_id: string };
    scheduledJobId = d.job_id;
    return { passed: !!scheduledJobId, detail: `job_id=${scheduledJobId?.slice(0, 8)}` };
  });

  // E3 — verifica label + priority no DB
  await run("E", "E3 job DB tem label + priority esperados", async () => {
    if (!scheduledJobId) return { passed: false, detail: "skip (E2 falhou)" };
    const { data } = await supa
      .from("bulk_message_jobs")
      .select("label, priority, status")
      .eq("id", scheduledJobId)
      .maybeSingle();
    if (!data) return { passed: false, detail: "row não achada" };
    return {
      passed: data.label === "smoke test E2" && data.priority === 80,
      detail: `label="${data.label}" priority=${data.priority} status=${data.status}`,
    };
  });

  // E4 — dashboard mostra o job
  await run("E", "E4 bulk_dashboard mostra esse job no active_jobs", async () => {
    if (!scheduledJobId) return { passed: false, detail: "skip" };
    const r = await callTool(ctx, "bulk_dashboard", {});
    const d = r.data as { active_jobs: Array<{ job_id: string; priority: number; label: string | null }> };
    const found = d.active_jobs?.find((j) => j.job_id === scheduledJobId);
    return {
      passed: !!found && found.priority === 80,
      detail: found
        ? `found label="${found.label}" priority=${found.priority}`
        : `não achou job ${scheduledJobId.slice(0, 8)} em ${d.active_jobs?.length} ativos`,
    };
  });

  // E5 — pause_all
  await run("E", "E5 bulk_pause_all pausa o job", async () => {
    const r = await callTool(ctx, "bulk_pause_all", { confirmed_by_rep: true });
    const d = r.data as { paused_count: number };
    return { passed: r.status === "ok" && d.paused_count >= 1, detail: `paused=${d?.paused_count}` };
  });

  // E6 — resume_all
  await run("E", "E6 bulk_resume_all retoma", async () => {
    const r = await callTool(ctx, "bulk_resume_all", { confirmed_by_rep: true });
    const d = r.data as { resumed_count: number };
    return { passed: r.status === "ok" && d.resumed_count >= 1, detail: `resumed=${d?.resumed_count}` };
  });

  // E7 — reschedule pra amanhã
  await run("E", "E7 bulk_reschedule_job pra amanhã", async () => {
    if (!scheduledJobId) return { passed: false, detail: "skip" };
    const newStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const r = await callTool(ctx, "bulk_reschedule_job", {
      job_id: scheduledJobId,
      new_start_at: newStart,
      confirmed_by_rep: true,
    });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 120)}` };
    const d = r.data as { rescheduled: number; new_first_send: string };
    return {
      passed: d.rescheduled >= 1,
      detail: `rescheduled=${d.rescheduled} new_first=${d.new_first_send}`,
    };
  });

  // E8 — edit template
  await run("E", "E8 bulk_edit_pending_job new_template + re-interpolation", async () => {
    if (!scheduledJobId) return { passed: false, detail: "skip" };
    const r = await callTool(ctx, "bulk_edit_pending_job", {
      job_id: scheduledJobId,
      new_template: "Texto editado smoke E8 {first_name}",
      confirmed_by_rep: true,
    });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 120)}` };
    const d = r.data as { recipients_reinterpolated: number };

    // Confirma DB: template novo no job + personalized_message dos pending
    const { data: jobRow } = await supa.from("bulk_message_jobs").select("message_template").eq("id", scheduledJobId).maybeSingle();
    const { data: pending } = await supa.from("bulk_message_recipients").select("personalized_message").eq("job_id", scheduledJobId).eq("status", "pending").limit(1);
    const tmplOk = jobRow?.message_template === "Texto editado smoke E8 {first_name}";
    const personalizedOk = (pending?.[0]?.personalized_message || "").startsWith("Texto editado smoke E8 ");
    return {
      passed: tmplOk && personalizedOk && d.recipients_reinterpolated >= 1,
      detail: `tmpl_ok=${tmplOk} personalized_ok=${personalizedOk} reinterpolated=${d.recipients_reinterpolated}`,
    };
  });

  // E9 — cancel all (cleanup)
  await run("E", "E9 bulk_cancel_all cleanup", async () => {
    const r = await callTool(ctx, "bulk_cancel_all", {
      confirmed_by_rep: true,
      reason: "smoke test cleanup E9",
    });
    if (r.status !== "ok") return { passed: false, detail: `status=${r.status}` };
    const d = r.data as { cancelled_count: number };
    return { passed: d.cancelled_count >= 1, detail: `cancelled=${d.cancelled_count}` };
  });

  // =====================================================================
  // F) FASE 3 — Smart cap
  // =====================================================================
  console.log("\n[F] FASE 3 — Smart cap");

  await run("F", "F1 DEFAULT_DAILY_BULK_CAP === 300", async () => {
    return { passed: DEFAULT_DAILY_BULK_CAP === 300, detail: `value=${DEFAULT_DAILY_BULK_CAP}` };
  });

  await run("F", "F2 getEffectiveDailyCap === base (sem overrides hoje)", async () => {
    const baseFake = 100;
    const eff = await getEffectiveDailyCap(LOC, baseFake, new Date());
    return { passed: eff === baseFake, detail: `eff=${eff} esperado=${baseFake}` };
  });

  await run("F", "F3 getWeeklyCap retorna null se não configurado", async () => {
    const wk = await getWeeklyCap(agentId);
    return {
      passed: wk === null || typeof wk === "number",
      detail: `weekly_cap=${wk} (null OK se sem config)`,
    };
  });

  await run("F", "F4 countRecipientsLast7Days retorna número", async () => {
    const c = await countRecipientsLast7Days(LOC);
    return { passed: typeof c === "number" && c >= 0, detail: `last7d=${c}` };
  });

  // =====================================================================
  // G) FASE 3 — Per-contact cooldown
  // =====================================================================
  console.log("\n[G] FASE 3 — Per-contact cooldown");

  // Limpa primeiro qualquer cooldown desse contact de teste
  const fakeContactId = `smoketest_contact_${Date.now()}`;

  await run("G", "G1 getContactsWithRecentBulk Map vazio antes", async () => {
    const map = await getContactsWithRecentBulk(LOC, [fakeContactId]);
    return { passed: map.size === 0, detail: `map_size=${map.size}` };
  });

  await run("G", "G2 recordContactBulkSent cria row", async () => {
    await recordContactBulkSent(fakeContactId, LOC, null);
    const { data } = await supa
      .from("bulk_contact_cooldown")
      .select("contact_id, send_count_30d")
      .eq("contact_id", fakeContactId)
      .eq("location_id", LOC)
      .maybeSingle();
    return {
      passed: !!data && data.contact_id === fakeContactId,
      detail: data ? `row count_30d=${data.send_count_30d}` : "row não criada",
    };
  });

  await run("G", "G3 getContactsWithRecentBulk Map com 1 entry depois", async () => {
    const map = await getContactsWithRecentBulk(LOC, [fakeContactId]);
    const entry = map.get(fakeContactId);
    return {
      passed: map.size === 1 && !!entry && entry.hours_ago === 0,
      detail: `map_size=${map.size} hours_ago=${entry?.hours_ago}`,
    };
  });

  await run("G", "G4 cleanup cooldown row", async () => {
    const { error } = await supa
      .from("bulk_contact_cooldown")
      .delete()
      .eq("contact_id", fakeContactId)
      .eq("location_id", LOC);
    return { passed: !error, detail: error ? error.message : "deleted" };
  });

  // =====================================================================
  // H) FASE 4 — Anti-duplicação (findSimilarActiveJobs)
  // =====================================================================
  console.log("\n[H] FASE 4 — Anti-duplicação");

  const templateA = "Olá {first_name}, vou te mandar info sobre nosso seguro de vida e investimento futuro.";
  const templateB = "Receita de bolo de chocolate: 2 xícaras de farinha, 3 ovos, açúcar e cacau em pó.";

  await run("H", "H1 findSimilarActiveJobs sem jobs ativos → []", async () => {
    const m = await findSimilarActiveJobs(rep.id, LOC, templateA);
    return { passed: m.length === 0, detail: `matches=${m.length}` };
  });

  // H2/H3 — cria 1 job ativo com templateA, testa similarity
  let h2JobId: string | null = null;
  await run("H", "H2 cria job com template similar → match", async () => {
    if (!testContactId) return { passed: false, detail: "skip (sem contato)" };
    // Schedule novo job pra testar (será cancelado no final)
    const sr = await callTool(ctx, "schedule_bulk_message_v2", {
      segments: [
        {
          label: "smoke test H2",
          filter: buildSingleContactFilter(),
          message_template: templateA,
        },
      ],
      list_temperature: "warm",
      label: "smoke test H2",
      priority: 50,
      confirmed_by_rep: true,
      confirmed_warm_list: true,
      start_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      delivery_strategy: { type: "today" },
    });
    if (sr.status !== "ok") return { passed: false, detail: `schedule falhou: ${(sr as { message?: string }).message?.slice(0, 120)}` };
    h2JobId = (sr.data as { job_id: string }).job_id;
    // Agora findSimilar com mesmo template
    const m = await findSimilarActiveJobs(rep.id, LOC, templateA);
    return {
      passed: m.length >= 1 && m[0].similarity >= 0.7,
      detail: `matches=${m.length} top_sim=${m[0]?.similarity}`,
    };
  });

  await run("H", "H3 template completamente diferente → 0 matches", async () => {
    const m = await findSimilarActiveJobs(rep.id, LOC, templateB);
    return {
      passed: m.length === 0,
      detail: `matches=${m.length} (esperado 0 — bolo vs seguro)`,
    };
  });

  // Cleanup H2 job
  await run("H", "H_cleanup cancel H2 job", async () => {
    const r = await callTool(ctx, "bulk_cancel_all", {
      confirmed_by_rep: true,
      reason: "smoke test cleanup H",
    });
    const d = r.data as { cancelled_count: number };
    return { passed: r.status === "ok", detail: `cancelled=${d?.cancelled_count}` };
  });

  // =====================================================================
  // I) FASE 5 — Loop detection
  // =====================================================================
  console.log("\n[I] FASE 5 — Loop detection (turn-context)");

  await run("I", "I1 createTurnContext repeated_questions vazio", async () => {
    const s = createTurnContext();
    return { passed: Object.keys(s.repeated_questions).length === 0, detail: `keys=${Object.keys(s.repeated_questions).length}` };
  });

  await run("I", "I2 recordQuestion 3x → questionCount === 3", async () => {
    const s = createTurnContext();
    recordQuestion(s, "warm_status");
    recordQuestion(s, "warm_status");
    recordQuestion(s, "warm_status");
    const c = questionCount(s, "warm_status");
    return { passed: c === 3, detail: `count=${c}` };
  });

  await run("I", "I3 renderTurnContextForPrompt inclui ALERTAS DE LOOP", async () => {
    const s = createTurnContext();
    recordQuestion(s, "warm_status");
    recordQuestion(s, "warm_status");
    const r = renderTurnContextForPrompt(s);
    return { passed: /ALERTAS DE LOOP/.test(r), detail: `len=${r.length} has_alerts=${/ALERTAS DE LOOP/.test(r)}` };
  });

  // =====================================================================
  // J) FASE 5 — Bulk session state
  // =====================================================================
  console.log("\n[J] FASE 5 — Bulk session state");

  await run("J", "J1 recordBulkChoice warm_status === 'warm'", async () => {
    const s = createTurnContext();
    recordBulkChoice(s, "warm_status", "warm");
    return {
      passed: s.bulk_session_state?.warm_status === "warm",
      detail: `state=${JSON.stringify(s.bulk_session_state)}`,
    };
  });

  await run("J", "J2 autoRegisterFromToolResult com preview fake", async () => {
    const s = createTurnContext();
    autoRegisterFromToolResult(s, "preview_bulk_message_v2", {
      total_contacts: 42,
      list_temperature: "cold",
    });
    const bs = s.bulk_session_state;
    return {
      passed: bs?.last_preview_total_contacts === 42 && bs?.warm_status === "cold",
      detail: `state=${JSON.stringify(bs)}`,
    };
  });

  // =====================================================================
  // K) FASE 5 — Silence recovery
  // =====================================================================
  console.log("\n[K] FASE 5 — Silence recovery");

  await run("K", "K1 detectSilenceGap gap 60min + bot waiting", async () => {
    const now = Date.now();
    const msgs = [
      { role: "user" as const, content: "oi", created_at: new Date(now - 120 * 60_000).toISOString() },
      { role: "assistant" as const, content: "Qual contato? Confirma?", created_at: new Date(now - 60 * 60_000).toISOString() },
      { role: "user" as const, content: "voltei", created_at: new Date(now).toISOString() },
    ];
    const info = detectSilenceGap(msgs);
    return {
      passed: info !== null && info.gap_minutes >= 59 && info.bot_was_waiting === true,
      detail: `gap=${info?.gap_minutes}min waiting=${info?.bot_was_waiting}`,
    };
  });

  await run("K", "K2 gap 10min → null", async () => {
    const now = Date.now();
    const msgs = [
      { role: "assistant" as const, content: "ok", created_at: new Date(now - 10 * 60_000).toISOString() },
      { role: "user" as const, content: "oi", created_at: new Date(now).toISOString() },
    ];
    const info = detectSilenceGap(msgs);
    return { passed: info === null, detail: `info=${JSON.stringify(info)?.slice(0, 80)}` };
  });

  await run("K", "K3 último não-assistant → null", async () => {
    const now = Date.now();
    const msgs = [
      { role: "user" as const, content: "msg 1", created_at: new Date(now - 120 * 60_000).toISOString() },
      { role: "user" as const, content: "msg 2 atual", created_at: new Date(now).toISOString() },
    ];
    const info = detectSilenceGap(msgs);
    return { passed: info === null, detail: `info=${JSON.stringify(info)?.slice(0, 80)}` };
  });

  await run("K", "K4 renderSilenceRecoveryForPrompt gera bloco com gap", async () => {
    const out = renderSilenceRecoveryForPrompt({
      gap_minutes: 60,
      last_bot_at: new Date().toISOString(),
      last_bot_snippet: "Confirma?",
      bot_was_waiting: true,
    });
    const hasGap = /1h|60min/i.test(out);
    const hasHeader = /SILENCE GAP DETECTADO/i.test(out);
    return { passed: hasGap && hasHeader, detail: `len=${out.length} has_gap=${hasGap} has_header=${hasHeader}` };
  });

  // =====================================================================
  // L) V1 deprecation
  // =====================================================================
  console.log("\n[L] V1 deprecation");

  await run("L", "L1 preview_bulk_message description tem DEPRECATED", async () => {
    const e = TOOL_REGISTRY["preview_bulk_message"];
    if (!e) return { passed: false, detail: "tool não existe no registry" };
    const has = /DEPRECATED/i.test(e.def.description || "");
    return { passed: has, detail: `has_deprecated=${has}` };
  });

  await run("L", "L2 schedule_bulk_message description tem DEPRECATED", async () => {
    const e = TOOL_REGISTRY["schedule_bulk_message"];
    if (!e) return { passed: false, detail: "tool não existe no registry" };
    const has = /DEPRECATED/i.test(e.def.description || "");
    return { passed: has, detail: `has_deprecated=${has}` };
  });

  await run("L", "L3 Ambas tools v1 ainda existem (compat)", async () => {
    const p = !!TOOL_REGISTRY["preview_bulk_message"];
    const s = !!TOOL_REGISTRY["schedule_bulk_message"];
    return { passed: p && s, detail: `preview=${p} schedule=${s}` };
  });

  // =====================================================================
  // Final cleanup: garantir 0 jobs ativos do Pedro
  // =====================================================================
  console.log("\n[CLEANUP] Final cleanup");
  const finalCancel = await callTool(ctx, "bulk_cancel_all", {
    confirmed_by_rep: true,
    reason: "smoke test final cleanup",
  });
  if (finalCancel.status === "ok") {
    const d = finalCancel.data as { cancelled_count: number };
    console.log(`  Final cancelled: ${d.cancelled_count}`);
  }
  // Garante 0 overrides leftover
  const { count: leftoverOverrides } = await supa
    .from("bulk_cap_overrides")
    .select("id", { count: "exact", head: true })
    .eq("rep_identity_id", rep.id)
    .like("reason", "smoke%");
  console.log(`  Overrides leftover (smoke%): ${leftoverOverrides ?? 0}`);
  if ((leftoverOverrides ?? 0) > 0) {
    await supa.from("bulk_cap_overrides").delete().eq("rep_identity_id", rep.id).like("reason", "smoke%");
  }

  // =====================================================================
  // SUMMARY
  // =====================================================================
  console.log("\n" + "=".repeat(80));
  console.log("SUMÁRIO");
  console.log("=".repeat(80));
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  // Por grupo
  const byGroup = new Map<string, { p: number; t: number }>();
  for (const r of results) {
    const g = byGroup.get(r.group) ?? { p: 0, t: 0 };
    g.t++;
    if (r.passed) g.p++;
    byGroup.set(r.group, g);
  }
  console.log("\nPor grupo:");
  for (const [g, { p, t }] of byGroup) {
    const icon = p === t ? "OK" : "WARN";
    console.log(`  [${icon}] ${g}: ${p}/${t}`);
  }

  // Falhas detalhadas
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log(`\nFALHAS (${failures.length}):`);
    for (const f of failures) {
      console.log(`  [FAIL] [${f.group}] ${f.name}`);
      console.log(`         ${f.detail}`);
      if (f.error) {
        console.log(`         ERR: ${f.error.split("\n")[0]}`);
      }
    }
  }

  const totalTime = results.reduce((a, r) => a + r.duration_ms, 0);
  console.log(`\nTotal: ${passed}/${total} (${Math.round((passed / total) * 100)}%) em ${totalTime}ms`);
  console.log(passed === total ? "\nALL GREEN" : `\n${total - passed} test(s) com problema — revisar acima.`);
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
