// Sanity test E2E: chama os HANDLERS reais das tools refatoradas
// (não a API GHL crua) e confirma que paginação + stage_name + tag funcionam.
//
// READ-ONLY. NÃO envia mensagem ao Gustavo nem modifica nada.
//
// Roda com: npx tsx -r tsconfig-paths/register scripts/sanity-gustavo-tools.ts

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import type { ToolContext } from "@/lib/account-assistant/tools/types";
import type { RepIdentity } from "@/types/account-assistant";
import { TOOL_REGISTRY } from "@/lib/account-assistant/tools";

const GUSTAVO_LOC = "b1ttBRVEnm5joFvP2UXO";
const GUSTAVO_USER = "9T25p4sCJbdndMyZcIRd";

async function main() {
  console.log("\n=== Sanity E2E Tools (Gustavo) ===\n");

  // 1) Resolve company_id da location
  const supa = createAdminClient();
  const { data: loc } = await supa
    .from("locations")
    .select("company_id, location_name, timezone")
    .eq("location_id", GUSTAVO_LOC)
    .single();
  if (!loc?.company_id) {
    console.error("location não sincronizada");
    process.exit(1);
  }
  console.log(`Location: ${loc.location_name} | tz=${loc.timezone}`);

  // 2) Pega rep do Gustavo
  const { data: rep } = await supa
    .from("rep_identities")
    .select("*")
    .eq("phone", "+17542650461")
    .single();
  if (!rep) {
    console.error("rep não encontrado");
    process.exit(1);
  }
  console.log(`Rep: ${rep.display_name} (${rep.id})`);

  const ghl = new GHLClient(loc.company_id, GUSTAVO_LOC);
  const ctx: ToolContext = {
    rep: rep as unknown as RepIdentity,
    locationId: GUSTAVO_LOC,
    companyId: loc.company_id,
    ghlClient: ghl,
    confirmationMode: "high_only",
    testSessionId: null,
  };

  // === TEST 1: list_opportunities com stage_name='M3' ===
  console.log("\n[TEST 1] list_opportunities(stage_name='M3')");
  const t0 = Date.now();
  const listOpps = TOOL_REGISTRY["list_opportunities"];
  if (!listOpps) {
    console.error("tool list_opportunities não registrada!");
    process.exit(1);
  }
  const r1 = await listOpps.handler(ctx, { stage_name: "M3", status: "open" });
  const dt1 = Date.now() - t0;
  console.log(`  ⏱ ${dt1}ms`);
  if (r1.status !== "ok") {
    console.error(`  FAIL: status=${r1.status} msg=${(r1 as { message?: string }).message}`);
  } else {
    const d = r1.data as {
      opportunities: unknown[];
      complete: boolean;
      total_returned: number;
      pages_fetched: number;
      stage_resolved?: string;
      total_reported_by_ghl?: number;
    };
    console.log(`  ✓ ${d.opportunities.length} opps`);
    console.log(`  complete=${d.complete} pages=${d.pages_fetched}`);
    console.log(`  stage_resolved="${d.stage_resolved}"`);
    console.log(`  total_reported_by_ghl=${d.total_reported_by_ghl}`);
    if (d.total_returned === 6 && d.complete) {
      console.log("  ✅ ESPERADO: M3 = 6 opps, complete=true. PASS.");
    } else {
      console.log(`  ⚠️  ESPERADO 6 opps; obtido ${d.total_returned}`);
    }
  }

  // === TEST 2: list_opportunities sem filtro (puxa tudo) ===
  console.log("\n[TEST 2] list_opportunities() — pull tudo open via paginação");
  const t1 = Date.now();
  const r2 = await listOpps.handler(ctx, { status: "open" });
  const dt2 = Date.now() - t1;
  console.log(`  ⏱ ${dt2}ms`);
  if (r2.status !== "ok") {
    console.error(`  FAIL: ${(r2 as { message?: string }).message}`);
  } else {
    const d = r2.data as {
      opportunities: unknown[];
      complete: boolean;
      pages_fetched: number;
      total_reported_by_ghl?: number;
    };
    console.log(`  ✓ ${d.opportunities.length} opps total (esperado ~941)`);
    console.log(`  complete=${d.complete} pages=${d.pages_fetched}`);
    if (d.opportunities.length >= 900 && d.complete) {
      console.log("  ✅ PASS — pagination puxou tudo.");
    } else {
      console.log(`  ⚠️ achei só ${d.opportunities.length}, esperado ~941`);
    }
  }

  // === TEST 3: list_opportunities stage_name ambíguo ===
  console.log("\n[TEST 3] list_opportunities(stage_name='M') — esperado ambiguo");
  const r3 = await listOpps.handler(ctx, { stage_name: "M" });
  if (r3.status === "error") {
    console.log(`  ✓ rejeitou (ambíguo): ${r3.message.slice(0, 120)}...`);
  } else {
    console.log(`  ⚠️  esperava error ambíguo, obtive status=${r3.status}`);
  }

  // === TEST 4: search_contacts com tag ===
  console.log("\n[TEST 4] search_contacts(tag='mora perto de boca raton')");
  const t2 = Date.now();
  const search = TOOL_REGISTRY["search_contacts"];
  if (!search) {
    console.error("search_contacts não registrada");
    process.exit(1);
  }
  const r4 = await search.handler(ctx, { tag: "mora perto de boca raton" });
  const dt4 = Date.now() - t2;
  console.log(`  ⏱ ${dt4}ms`);
  if (r4.status !== "ok") {
    console.error(`  FAIL: ${(r4 as { message?: string }).message}`);
  } else {
    const d = r4.data as {
      contacts: unknown[];
      complete: boolean;
      pages_fetched: number;
      total_reported_by_ghl?: number;
      method?: string;
    };
    console.log(`  ✓ ${d.contacts.length} contatos`);
    console.log(`  complete=${d.complete} pages=${d.pages_fetched}`);
    console.log(`  total_reported_by_ghl=${d.total_reported_by_ghl}`);
    console.log(`  method=${d.method}`);
    if (d.contacts.length === 52 && d.complete) {
      console.log("  ✅ ESPERADO: tag = 52, complete=true. PASS.");
    } else {
      console.log(`  ⚠️  ESPERADO 52; obtido ${d.contacts.length}`);
    }
  }

  // === TEST 5: search_contacts apenas query (fast path GET) ===
  console.log("\n[TEST 5] search_contacts(query='Gustavo') — fast path GET");
  const r5 = await search.handler(ctx, { query: "Gustavo" });
  if (r5.status === "ok") {
    const d = r5.data as { contacts: unknown[]; method?: string };
    console.log(`  ✓ ${d.contacts.length} contatos | method=${d.method}`);
    console.log("  ✅ PASS (fast path GET ativado).");
  } else if (r5.status === "not_found") {
    console.log(`  ⚠️ not_found (esperado se nenhum contato 'Gustavo')`);
  } else {
    console.log(`  FAIL: ${(r5 as { message?: string }).message}`);
  }

  // === TEST 6: list_opportunities partial stage_name (M0 → "Inscrito e na M0") ===
  console.log("\n[TEST 6] list_opportunities(stage_name='M0')");
  const r6 = await listOpps.handler(ctx, { stage_name: "M0" });
  if (r6.status === "ok") {
    const d = r6.data as {
      opportunities: unknown[];
      stage_resolved?: string;
      complete: boolean;
    };
    console.log(`  ✓ ${d.opportunities.length} opps no '${d.stage_resolved}'`);
    console.log(`  complete=${d.complete}`);
    if (d.opportunities.length === 19) {
      console.log("  ✅ ESPERADO: M0 = 19 opps. PASS.");
    } else {
      console.log(`  ⚠️ esperava 19, obtive ${d.opportunities.length}`);
    }
  } else {
    console.log(`  FAIL: ${(r6 as { message?: string }).message}`);
  }

  console.log("\n=== FIM ===\n");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
