/**
 * Read-only: lista os custom fields do GHL da conta da Marina (pro mapeamento
 * sync_to_ghl dos data_fields email/whatsapp/etc). Não envia nada.
 *   npx tsx -r tsconfig-paths/register scripts/fetch-marina-custom-fields.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "A62s5EQj1hldOuvBEowv";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  let cf: any[] = [];
  try {
    cf = (await client.get<{ customFields: any[] }>(`/locations/${LOCATION}/customFields`)).customFields || [];
  } catch {
    cf = (await client.get<{ customFields: any[] }>(`/customFields`, { locationId: LOCATION })).customFields || [];
  }
  console.log(`${cf.length} custom field(s):`);
  for (const f of cf) console.log(`  id=${f.id} | name="${f.name}" | key=${f.fieldKey || f.key || ""} | type=${f.dataType || f.type || ""}`);
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
