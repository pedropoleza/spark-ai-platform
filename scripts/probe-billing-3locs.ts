import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { getLocationToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const APP_ID = "67cf4ed48fa066a72e313796";
const METER_ID = "6a0a5fa1242130a40f274e87";

async function probe(loc: string) {
  const token = await getLocationToken(COMPANY, loc);
  const eid = `probe-${Date.now()}-${loc.slice(0, 6)}`;
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
      eventId: eid,
      companyId: COMPANY,
      locationId: loc,
      units: 1,
      price: 0.01,
      description: "[PROBE] Spark AI",
    }),
  });
  const body = await r.text();
  console.log(`${loc}: ${r.status}`);
  console.log(`  ${body.slice(0, 350)}`);
}

async function main() {
  for (const loc of [
    "H09HtG22LZzTU8htMxxg",      // Pedro (your)
    "RBFxlEQZobaDjlF2i5px",      // Hub
    "b1ttBRVEnm5joFvP2UXO",      // Gustavo
  ]) {
    await probe(loc);
  }
}
main();
