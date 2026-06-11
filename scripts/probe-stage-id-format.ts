/**
 * Probe pré-launch 2026-06-10: confirma o FORMATO REAL dos pipeline stage IDs
 * do GHL numa location de produção, e roda validateGhlId em cada um pra provar
 * (ou refutar) o bug do move_opportunity (review P1).
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/probe-stage-id-format.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { getPipelines } from "../src/lib/ghl/operations";
import { validateGhlId } from "../src/lib/account-assistant/tools/types";

const LOCATIONS = [
  { id: "jA6uzx6tONyTeocxw4Cj", name: "Five Star Ricos" },
  { id: "YuR0LCZomFzrfkDK2ezo", name: "Alves Cury" },
];

async function main() {
  const supabase = createAdminClient();
  for (const loc of LOCATIONS) {
    const { data } = await supabase.from("locations").select("company_id").eq("location_id", loc.id).maybeSingle();
    if (!data?.company_id) { console.log(`\n[${loc.name}] sem company_id — skip`); continue; }
    const client = new GHLClient(data.company_id, loc.id);
    let res;
    try {
      res = await getPipelines(client, loc.id);
    } catch (e) {
      console.log(`\n[${loc.name}] getPipelines falhou: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    console.log(`\n========== ${loc.name} (${loc.id}) ==========`);
    for (const p of res.pipelines || []) {
      console.log(`PIPELINE id=${p.id} (len ${p.id.length}, hífen=${p.id.includes("-")}) "${p.name}"`);
      for (const s of p.stages || []) {
        const rejected = validateGhlId(s.id, "stage") !== null;
        console.log(
          `   STAGE id=${s.id} (len ${s.id.length}, hífen=${s.id.includes("-")}) ` +
          `validateGhlId=${rejected ? "❌ REJEITA" : "✅ aceita"}  "${s.name}"`,
        );
      }
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
