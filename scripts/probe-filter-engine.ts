// Probe da Filter Engine contra location de teste do Pedro (Insurance Snapshot).
//
// Testa:
//   1. resolveAliases (stage_name, custom field slug)
//   2. compile + execute pra cada cenário típico
//   3. count_filter (otimizado)
//   4. Paginação ilimitada
//   5. Client-side fallback (dateOfBirth)
//   6. Multi-segment dedup (futuro, quando bulk V2 vier)
//
// READ-ONLY. NÃO envia nada pra ninguém.
//
// Roda com: npx tsx -r tsconfig-paths/register scripts/probe-filter-engine.ts

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import {
  executeContactsFilter,
  executeOpportunitiesFilter,
  countFilter,
  getPipelines,
  getCustomFields,
  invalidateAll,
} from "@/lib/account-assistant/filter-engine";
import type { FilterExpression, FilterExecutionContext } from "@/lib/account-assistant/filter-engine";

const LOC = "H09HtG22LZzTU8htMxxg";  // Insurance Snapshot
const COMPANY = "TdmQMjj86Y3LgppiB96K";
const PEDRO_REP_ID = "1eeb02cc-1a48-4b56-b177-52dcbca07ac2"; // John Doe

async function main() {
  console.log("\n=== Filter Engine Probe — Pedro location ===\n");

  const supa = createAdminClient();
  const { data: loc } = await supa
    .from("locations")
    .select("company_id, location_name, timezone")
    .eq("location_id", LOC)
    .single();
  if (!loc) {
    console.error("location não sincronizada");
    process.exit(1);
  }
  console.log(`Location: ${loc.location_name || "(sem nome)"} | tz=${loc.timezone}\n`);

  const ghl = new GHLClient(loc.company_id, LOC);
  const ctx: FilterExecutionContext = {
    rep_id: PEDRO_REP_ID,
    location_id: LOC,
    company_id: loc.company_id,
    ghl_client: ghl,
    consumer_tool: "probe",
    rep_aliases: { __self_user_id: "sE1dTJ53StGnL5hno3Ia" },
  };

  // === 0. Cache warmup ===
  console.log("[0] Warmup cache: pipelines + customFields");
  try {
    const pipes = await getPipelines(ghl, LOC);
    console.log(`   ✓ ${pipes.length} pipelines em cache`);
    for (const p of pipes.slice(0, 3)) {
      console.log(`     - ${p.name} (${p.stages.length} stages)`);
    }
  } catch (err) {
    console.warn(`   ⚠ pipelines fetch falhou: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const cfs = await getCustomFields(ghl, LOC);
    console.log(`   ✓ ${cfs.length} custom fields em cache`);
    for (const cf of cfs.slice(0, 3)) {
      console.log(`     - ${cf.name} (key=${cf.fieldKey || "(sem)"}, type=${cf.dataType})`);
    }
  } catch (err) {
    console.warn(`   ⚠ customFields fetch falhou: ${err instanceof Error ? err.message : err}`);
  }

  // === 1. Filter por tag (server-side) ===
  console.log("\n[1] Contacts com tag 'lead' (server-side V2)");
  const t1 = Date.now();
  const r1 = await executeContactsFilter(
    { field: "tags", op: "contains", value: "lead" },
    ctx,
  );
  console.log(`   ⏱ ${Date.now() - t1}ms`);
  if (r1.status === "ok") {
    console.log(`   ✓ ${r1.total_returned} contatos (reportado pelo GHL: ${r1.total_reported_by_ghl})`);
    console.log(`   complete=${r1.complete} pages=${r1.pages_fetched}`);
    console.log(`   plan: ${r1.plan?.map((p) => p.action).join(" → ")}`);
  } else {
    console.error(`   ✗ ${r1.message}`);
  }

  // === 2. Count-only (otimizado, 1 chamada) ===
  console.log("\n[2] Count-only: opps abertas (sem listar)");
  const t2 = Date.now();
  const c2 = await countFilter(
    "opportunities",
    { field: "opportunity.status", op: "eq", value: "open" },
    ctx,
  );
  console.log(`   ⏱ ${Date.now() - t2}ms`);
  console.log(`   ✓ ${c2.count} opps abertas`);

  // === 3. AND combinado (stage + valor mínimo) ===
  console.log("\n[3] Opps no stage 'open' + valor >= 1000");
  const t3 = Date.now();
  const expr3: FilterExpression = {
    all: [
      { field: "opportunity.status", op: "eq", value: "open" },
      { field: "opportunity.monetaryValue", op: "gte", value: 1000 },
    ],
  };
  const r3 = await executeOpportunitiesFilter(expr3, ctx);
  console.log(`   ⏱ ${Date.now() - t3}ms`);
  if (r3.status === "ok") {
    console.log(`   ✓ ${r3.total_returned} opps (plan: ${r3.plan?.map((p) => p.action).join(" → ")})`);
  } else {
    console.error(`   ✗ ${r3.message}`);
  }

  // === 4. Client-side fallback (dateOfBirth) ===
  console.log("\n[4] Contatos aniversariando hoje (client-side — dateOfBirth não server)");
  const todayMMDD = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const t4 = Date.now();
  const r4 = await executeContactsFilter(
    { field: "dateOfBirth", op: "month_day_eq", value: todayMMDD },
    ctx,
    { limit: 1000 },  // cap menor pra probe não demorar muito
  );
  console.log(`   ⏱ ${Date.now() - t4}ms`);
  if (r4.status === "ok") {
    console.log(`   ✓ ${r4.total_returned} aniversariantes em ${todayMMDD} (de ${r4.pages_fetched} pages × 100)`);
    console.log(`   client_side_applied=true | hit_safety_cap=${r4.hit_safety_cap}`);
  } else {
    console.error(`   ✗ ${r4.message}`);
  }

  // === 5. OR via 'in' (várias tags) ===
  console.log("\n[5] OR via 'in': contatos com tag 'lead' OU 'cliente'");
  const t5 = Date.now();
  const expr5: FilterExpression = {
    any: [
      { field: "tags", op: "contains", value: "lead" },
      { field: "tags", op: "contains", value: "cliente" },
    ],
  };
  const r5 = await executeContactsFilter(expr5, ctx);
  console.log(`   ⏱ ${Date.now() - t5}ms`);
  if (r5.status === "ok") {
    console.log(`   ✓ ${r5.total_returned} contatos (union)`);
  } else {
    console.error(`   ✗ ${r5.message}`);
  }

  // === 6. Stage_name alias (deve resolver) ===
  console.log("\n[6] Alias stage_name (probe pode falhar se Pedro não tem 'M0' nessa loc)");
  const t6 = Date.now();
  try {
    const r6 = await executeOpportunitiesFilter(
      { field: "opportunity.stageName", op: "eq", value: "Lead" },
      ctx,
      { limit: 50 },
    );
    console.log(`   ⏱ ${Date.now() - t6}ms`);
    if (r6.status === "ok") {
      console.log(`   ✓ stage 'Lead' resolvido → ${r6.total_returned} opps`);
      console.log(`   applied aliases:`, r6.applied_aliases);
    } else {
      console.error(`   ✗ ${r6.message}`);
    }
  } catch (err) {
    console.warn(`   ⚠ erro: ${err instanceof Error ? err.message : err}`);
  }

  // === 7. Audit verification ===
  console.log("\n[7] Audit log filter_executions");
  const { data: audits } = await supa
    .from("filter_executions")
    .select("entity, status, duration_ms, total_returned, hit_safety_cap, consumer_tool")
    .eq("rep_id", PEDRO_REP_ID)
    .eq("consumer_tool", "probe")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log(`   ✓ ${audits?.length || 0} audit rows criadas neste probe`);
  if (audits) {
    for (const a of audits.slice(0, 5)) {
      console.log(`     - ${a.entity} ${a.status} ${a.duration_ms}ms ${a.total_returned} items${a.hit_safety_cap ? " (capped)" : ""}`);
    }
  }

  // === Cleanup cache (não polui próximas runs)
  invalidateAll();

  console.log("\n=== FIM ===\n");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
