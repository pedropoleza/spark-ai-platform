/**
 * Probe efêmero 3/3 (rodada 2 Marcia) — READ-ONLY.
 * Procura DUPLICATAS da Narjara/Rodrigo (outro record que a IA possa estar
 * trabalhando como lead novo) na location jA6u.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  for (const q of ["narjara", "rodrigo sancho", "viganor", "melgaço", "2037062691"]) {
    const res = await client.get<{ contacts?: Array<Record<string, unknown>> }>(
      "/contacts/", { locationId: LOCATION_ID, query: q, limit: 20 },
    );
    const list = res.contacts || [];
    console.log(`\n=== query "${q}" → ${list.length} ===`);
    for (const c of list) {
      console.log(JSON.stringify({ id: c.id, name: c.contactName, phone: c.phone, tags: c.tags, dateAdded: c.dateAdded }));
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
