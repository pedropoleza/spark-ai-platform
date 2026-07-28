import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve("/Users/pedropoleza/SPARK APPS/wt-marcia", ".env.local") });
import { createAdminClient } from "/Users/pedropoleza/SPARK APPS/wt-marcia/src/lib/supabase/admin";
import { GHLClient } from "/Users/pedropoleza/SPARK APPS/wt-marcia/src/lib/ghl/client";
async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", "jA6uzx6tONyTeocxw4Cj").maybeSingle();
  const client = new GHLClient(loc!.company_id, "jA6uzx6tONyTeocxw4Cj");
  const pipes = await client.get<{ pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> }>("/opportunities/pipelines", { locationId: "jA6uzx6tONyTeocxw4Cj" });
  for (const p of pipes.pipelines || []) {
    console.log(`PIPELINE: ${p.name}`);
    for (const s of p.stages || []) console.log(`  - ${s.name}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
