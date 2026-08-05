/**
 * Read-only: lista os pipelines/estágios da Jussara (pra identificar o gatilho
 * "entrou em triagem" do fluxo pós-venda). Não envia nada.
 *   npx tsx -r tsconfig-paths/register scripts/fetch-jussara-pipelines.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "pGl5pqLLG0QDixANpFnP";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  const data = await client.get<{ pipelines?: any[] }>("/opportunities/pipelines", { locationId: LOCATION });
  const pipelines = data.pipelines || [];
  console.log(`${pipelines.length} pipeline(s):`);
  for (const p of pipelines) {
    console.log(`\n▸ PIPELINE "${p.name}" (id=${p.id})`);
    for (const s of p.stages || []) {
      console.log(`    estágio: "${s.name}" (id=${s.id})`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
