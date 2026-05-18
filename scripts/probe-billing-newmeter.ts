// Testa meterId novo no charge endpoint
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { getLocationToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const APP_ID = "67cf4ed48fa066a72e313796";
const METER_ID = "6a0a61378f59e16e17e049a8"; // NOVO meter no N8N App

async function probe(loc: string, label: string) {
  console.log(`\n=== ${label} (${loc}) ===`);
  const token = await getLocationToken(COMPANY, loc);

  const r = await fetch(`${GHL_API_BASE}/marketplace/billing/charges`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({
      appId: APP_ID,
      meterId: METER_ID,
      eventId: `probe-${Date.now()}-${loc.slice(0, 6)}`,
      companyId: COMPANY,
      locationId: loc,
      units: 1,
      price: 0.01,
      description: "[PROBE] Spark AI new meter test",
    }),
  });
  const body = await r.text();
  console.log(`Status: ${r.status}`);
  console.log(`Body: ${body.slice(0, 400)}`);
}

async function main() {
  for (const t of [
    { loc: "H09HtG22LZzTU8htMxxg", label: "Pedro" },
    { loc: "b1ttBRVEnm5joFvP2UXO", label: "Gustavo" },
    { loc: "dF2FDDZzSv715e1av4gr", label: "rep +15612" },
  ]) {
    await probe(t.loc, t.label);
  }
}
main();
