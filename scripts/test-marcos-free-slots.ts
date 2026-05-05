/**
 * Test direto da tool `list_my_free_slots` simulando o rep Marcos Alves.
 *
 * Usage: npx tsx scripts/test-marcos-free-slots.ts [when]
 *   when: today | tomorrow | week | next_week (default: tomorrow)
 *
 * Bypassa o LLM — chama o handler da tool diretamente contra GHL real do
 * Marcos pra ver o que retorna (slots livres, conflicts detectados, blocks
 * suspeitos, status, warnings).
 */
import { config } from "dotenv";
import { resolve } from "path";
// Carrega .env.local (next.js convention) ANTES de importar qualquer módulo
// que leia process.env no top-level (createAdminClient lê na chamada, mas
// o import de admin.ts pode disparar warnings).
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { CALENDAR_TOOLS } from "../src/lib/account-assistant/tools/calendar";
import { identifyRep, normalizePhone } from "../src/lib/account-assistant/identity";
import type { ToolContext } from "../src/lib/account-assistant/tools/types";

const MARCOS_PHONE = "+17864615477"; // +1 786 461-5477
const MARCOS_LOCATION_ID = "YuR0LCZomFzrfkDK2ezo";

const when = (process.argv[2] || "tomorrow") as "today" | "tomorrow" | "week" | "next_week";

async function main() {
  console.log(`\n=== TEST: list_my_free_slots(when="${when}") como Marcos ===\n`);

  // 1. Resolve rep Marcos
  const phoneNorm = normalizePhone(MARCOS_PHONE);
  console.log(`[1] Resolvendo rep com phone ${phoneNorm}...`);
  const rep = await identifyRep(phoneNorm);
  if (!rep) {
    console.error(`❌ Rep não encontrado pra phone ${phoneNorm}`);
    process.exit(1);
  }
  console.log(`✓ Rep: id=${rep.id} display_name="${rep.display_name}" timezone=${rep.timezone || "(default NY)"}`);
  console.log(`  ghl_users:`, rep.ghl_users);
  console.log(`  active_location_id=${rep.active_location_id}`);

  // 2. Resolve company_id da location
  const supa = createAdminClient();
  const { data: loc } = await supa
    .from("locations")
    .select("company_id, timezone")
    .eq("location_id", MARCOS_LOCATION_ID)
    .maybeSingle();
  if (!loc) {
    console.error(`❌ Location ${MARCOS_LOCATION_ID} não encontrada na DB`);
    process.exit(1);
  }
  console.log(`[2] Location: company_id=${loc.company_id} timezone=${loc.timezone}`);

  // 3. GHLClient
  const ghlClient = new GHLClient(loc.company_id, MARCOS_LOCATION_ID);

  // 4. ToolContext
  const ctx: ToolContext = {
    rep,
    locationId: MARCOS_LOCATION_ID,
    companyId: loc.company_id,
    ghlClient,
    testSessionId: null, // não é test mode — execução REAL
    confirmationMode: "high_only",
    enabledKbs: ["national_life_group", "agency_brazillionaires"],
  };

  // 5. Chama list_my_free_slots
  const tool = CALENDAR_TOOLS.find((t) => t.def.name === "list_my_free_slots");
  if (!tool) {
    console.error("❌ Tool list_my_free_slots não encontrada no registry");
    process.exit(1);
  }

  console.log(`\n[3] Chamando list_my_free_slots({ when: "${when}" })...\n`);
  const startTs = Date.now();
  const result = await tool.handler(ctx, { when });
  const durMs = Date.now() - startTs;

  console.log(`\n=== RESULTADO (${durMs}ms) ===`);
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "ok" || result.status === "degraded") {
    const data = result.data as {
      slots_by_date?: Record<string, string[]>;
      total_slots?: number;
      conflicts_found?: number;
      slots_removed_conflicts?: number;
      slots_removed_suspect_block?: number;
      suspect_block_examples?: string[];
      warning_partial?: string | null;
      window?: { start: string; end: string; timezone: string };
    };
    console.log(`\n=== RESUMO ===`);
    console.log(`Status: ${result.status}`);
    console.log(`Window: ${data.window?.start} → ${data.window?.end} (${data.window?.timezone})`);
    console.log(`Total slots: ${data.total_slots || 0}`);
    console.log(`Conflicts detectados: ${data.conflicts_found || 0}`);
    console.log(`Slots removidos por conflict: ${data.slots_removed_conflicts || 0}`);
    console.log(`Slots removidos como suspect block (Google Cal): ${data.slots_removed_suspect_block || 0}`);
    if (data.suspect_block_examples?.length) {
      console.log(`Suspect block examples:`);
      for (const ex of data.suspect_block_examples) console.log(`  - ${ex}`);
    }
    if (data.warning_partial) {
      console.log(`\n⚠️  Warning: ${data.warning_partial}`);
    }
    if (data.slots_by_date) {
      console.log(`\nSlots por dia:`);
      for (const [date, slots] of Object.entries(data.slots_by_date)) {
        console.log(`  ${date}: ${slots.length} slots`);
        for (const s of slots.slice(0, 5)) console.log(`    - ${s}`);
        if (slots.length > 5) console.log(`    ... +${slots.length - 5} mais`);
      }
    }
  }
}

main().catch((err) => {
  console.error("❌ FATAL:", err);
  process.exit(1);
});
