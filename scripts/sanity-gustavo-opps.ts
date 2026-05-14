// Sanity test: dados reais do Gustavo direto contra GHL.
// IMPORTANTE: read-only, NÃO envia mensagem nenhuma pra ninguém.
// Objetivo:
//   1. Quantas opps Gustavo tem no total (todos status)?
//   2. Quantas em cada stage de cada pipeline?
//   3. Quantos contatos com tag "mora perto de boca raton"?
//   4. Testar pagination (startAfter) do GHL — funciona?

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";

const GUSTAVO_LOC = "b1ttBRVEnm5joFvP2UXO";
const GUSTAVO_USER = "9T25p4sCJbdndMyZcIRd";

async function main() {
  const supa = createAdminClient();
  const { data: loc } = await supa
    .from("locations")
    .select("company_id, location_name, timezone")
    .eq("location_id", GUSTAVO_LOC)
    .single();
  if (!loc?.company_id) { console.error("location não sincronizada"); process.exit(1); }
  console.log(`Location: ${loc.location_name || "(sem nome)"} | tz=${loc.timezone}`);
  const ghl = new GHLClient(loc.company_id, GUSTAVO_LOC);

  // === STEP 1: Pipelines + stages ===
  console.log("\n=== 1. Pipelines e Stages ===");
  type PipelinesResp = {
    pipelines?: Array<{
      id: string;
      name: string;
      stages?: Array<{ id: string; name: string }>;
    }>;
  };
  const pipelinesRes = await ghl.get<PipelinesResp>("/opportunities/pipelines", {
    locationId: GUSTAVO_LOC,
  });
  const pipelines = pipelinesRes.pipelines || [];
  console.log(`Total pipelines: ${pipelines.length}`);
  for (const p of pipelines) {
    console.log(`  • ${p.name} (${p.id})`);
    for (const s of p.stages || []) {
      console.log(`      └ ${s.name} (${s.id})`);
    }
  }

  // === STEP 2: list_opportunities sem filter (página única, default 100) ===
  console.log("\n=== 2. /opportunities/search (1 página, limit=100) ===");
  type OppsResp = {
    opportunities?: Array<{
      id: string;
      name?: string;
      monetaryValue?: number;
      pipelineId?: string;
      pipelineStageId?: string;
      status?: string;
      assignedTo?: string;
      updatedAt?: string;
      contactId?: string;
      contact?: { name?: string };
    }>;
    meta?: {
      total?: number;
      nextPageUrl?: string;
      startAfterId?: string;
      startAfter?: number;
    };
  };
  const firstPage = await ghl.get<OppsResp>("/opportunities/search", {
    location_id: GUSTAVO_LOC,
    status: "open",
    assigned_to: GUSTAVO_USER,
    limit: "100",
  });
  const firstOpps = firstPage.opportunities || [];
  console.log(`Page 1: ${firstOpps.length} opps`);
  console.log(`meta:`, JSON.stringify(firstPage.meta || {}, null, 2));

  // === STEP 3: Pagination — tenta startAfterId ===
  console.log("\n=== 3. Pagination test (startAfter + startAfterId) ===");
  const allOpps: typeof firstOpps = [...firstOpps];
  let pageCount = 1;
  let lastMeta = firstPage.meta;
  while (lastMeta?.startAfterId && pageCount < 20) {
    const nextPage = await ghl.get<OppsResp>("/opportunities/search", {
      location_id: GUSTAVO_LOC,
      status: "open",
      assigned_to: GUSTAVO_USER,
      limit: "100",
      startAfterId: lastMeta.startAfterId,
      startAfter: String(lastMeta.startAfter || ""),
    });
    const pageOpps = nextPage.opportunities || [];
    if (pageOpps.length === 0) {
      console.log(`Page ${pageCount + 1}: 0 opps (fim)`);
      break;
    }
    allOpps.push(...pageOpps);
    pageCount++;
    console.log(
      `Page ${pageCount}: +${pageOpps.length} opps (total acum: ${allOpps.length})`,
    );
    lastMeta = nextPage.meta;
  }
  console.log(`\nTOTAL via pagination: ${allOpps.length} opps`);

  // === STEP 4: Counts por stage ===
  console.log("\n=== 4. Distribuição por stage ===");
  const stageMap = new Map<string, string>();
  for (const p of pipelines) {
    for (const s of p.stages || []) {
      stageMap.set(s.id, `${p.name} → ${s.name}`);
    }
  }
  const stageCounts = new Map<string, number>();
  for (const o of allOpps) {
    const stageName = stageMap.get(o.pipelineStageId || "") || "(unknown stage)";
    stageCounts.set(stageName, (stageCounts.get(stageName) || 0) + 1);
  }
  const sorted = Array.from(stageCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [stage, count] of sorted) {
    console.log(`  ${count.toString().padStart(3)} × ${stage}`);
  }

  // === STEP 5: Foco em stages do M3, M4 (Gustavo disse 6 no M3) ===
  console.log("\n=== 5. M3 e M4 detail (Gustavo disse M3=6) ===");
  for (const p of pipelines) {
    for (const s of p.stages || []) {
      if (/M3|M4|M0|M1|M2/i.test(s.name)) {
        const opps = allOpps.filter((o) => o.pipelineStageId === s.id);
        console.log(`\n  ${p.name} → ${s.name}: ${opps.length} opps`);
        for (const o of opps.slice(0, 10)) {
          console.log(
            `    • ${o.name || o.contact?.name || "(sem nome)"} — $${o.monetaryValue || 0}`,
          );
        }
      }
    }
  }

  // === STEP 6: tag "mora perto de boca raton" — 21 esperado ===
  console.log(`\n=== 6. Tag "mora perto de boca raton" ===`);
  console.log(`6a. GET /contacts/?query=tag — endpoint atual da tool`);
  type ContactsGet = {
    contacts?: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      name?: string;
      phone?: string;
      tags?: string[];
    }>;
  };
  try {
    const r1 = await ghl.get<ContactsGet>("/contacts/", {
      locationId: GUSTAVO_LOC,
      query: "mora perto de boca raton",
      limit: "20",
    });
    console.log(`  Result: ${r1.contacts?.length || 0} contatos (limit=20)`);
  } catch (err) {
    console.error(`  Err: ${err instanceof Error ? err.message.slice(0, 150) : err}`);
  }

  console.log(`\n6b. POST /contacts/search com filter tag (endpoint V2)`);
  type ContactsSearch = {
    contacts?: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      contactName?: string;
      phone?: string;
      tags?: string[];
    }>;
    total?: number;
  };
  let totalWithTag = 0;
  try {
    const r2 = await ghl.post<ContactsSearch>("/contacts/search", {
      locationId: GUSTAVO_LOC,
      filters: [
        {
          field: "tags",
          operator: "contains",
          value: "mora perto de boca raton",
        },
      ],
      pageLimit: 100,
    });
    totalWithTag = r2.contacts?.length || 0;
    console.log(`  Result: ${totalWithTag} contatos | total field: ${r2.total || "(n/a)"}`);
    for (const c of (r2.contacts || []).slice(0, 5)) {
      console.log(
        `    • ${c.contactName || c.firstName || "?"} — ${c.phone || "(sem phone)"}`,
      );
    }
  } catch (err) {
    console.error(`  Err: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
  }

  // === STEP 7: Resumo ===
  console.log(`\n\n=== RESUMO ===`);
  console.log(`Pipelines: ${pipelines.length}`);
  console.log(`Opps total via pagination: ${allOpps.length}`);
  console.log(`Pages percorridas: ${pageCount}`);
  console.log(`Tag "boca raton" via POST /search: ${totalWithTag}`);
  console.log(`\nGustavo disse: M3=6, tag=21 → confirmar acima`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
