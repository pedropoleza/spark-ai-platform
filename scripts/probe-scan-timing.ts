import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

async function main() {
  const sb = createAdminClient();
  const { data: locs } = await sb.from("locations").select("location_id, company_id").limit(15);
  const sample = (locs || []) as Array<{ location_id: string; company_id: string }>;
  const t0 = Date.now();
  let ok = 0, fail = 0;
  for (const l of sample) {
    try { await new GHLClient(l.company_id, l.location_id).get("/users/", { locationId: l.location_id }); ok++; }
    catch { fail++; }
  }
  const ms = Date.now() - t0;
  const per = ms / sample.length;
  console.log(`Amostra: ${sample.length} locations em ${(ms/1000).toFixed(1)}s (${per.toFixed(0)}ms/loc, ok=${ok} fail=${fail})`);
  console.log(`Extrapolado p/ 120 locations (sequencial): ${(per*120/1000).toFixed(0)}s  → limite do webhook = 60s`);
  console.log(per*120/1000 > 60 ? "❌ ESTOURA os 60s → timeout confirma o diagnóstico" : "⚠️ abaixo de 60s nesta amostra (pode estourar sob carga/latência GHL + webhook duplicado 2 apps)");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
