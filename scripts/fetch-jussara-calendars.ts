/**
 * Read-only: lista os calendários da conta da Jussara (pra pegar o calendar_id
 * pro agente de vendas agendar de verdade). Não envia nada.
 *   npx tsx -r tsconfig-paths/register scripts/fetch-jussara-calendars.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "pGl5pqLLG0QDixANpFnP";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  let calendars: any[] = [];
  try {
    const d = await client.get<{ calendars: any[] }>("/calendars/", { locationId: LOCATION });
    calendars = d.calendars || [];
  } catch (e) {
    console.warn("fallback /calendars/services:", e instanceof Error ? e.message : e);
    const d = await client.get<{ calendars: any[] }>("/calendars/services", { locationId: LOCATION });
    calendars = d.calendars || [];
  }
  console.log(`${calendars.length} calendário(s):`);
  for (const c of calendars) {
    console.log(`  - id=${c.id} | name="${c.name}" | active=${c.isActive ?? c.active ?? "?"} | slug=${c.slug || ""}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
