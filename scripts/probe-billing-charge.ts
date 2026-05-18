// Testa charge wallet diretamente pra ver erro real da GHL
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { getLocationToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
// Testa nas 3 locations com pending
const tests = [
  { loc: "dF2FDDZzSv715e1av4gr", amount: 0.01, label: "rep +15612" },
  { loc: "K9b92VcD0KdCMIn60y0W", amount: 0.01, label: "rep +17326" },
  { loc: "b1ttBRVEnm5joFvP2UXO", amount: 0.01, label: "Gustavo" },
];

async function chargeOne(loc: string, amountUsd: number, label: string) {
  console.log(`\n=== ${label} (${loc}) — charge $${amountUsd} ===`);
  let token: string;
  try {
    token = await getLocationToken(COMPANY, loc);
    console.log(`  ✓ location token OK (len=${token.length})`);
  } catch (e) {
    console.log(`  ❌ token fail:`, e instanceof Error ? e.message.slice(0, 200) : e);
    return;
  }

  const amountCents = Math.ceil(amountUsd * 100);
  const idempotencyKey = `probe-${Date.now()}-${loc.slice(0, 6)}`;

  try {
    const r = await fetch(`${GHL_API_BASE}/marketplace/billing/charges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Version: "2021-07-28",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        locationId: loc,
        amount: amountCents,
        description: `[PROBE] test charge ${amountUsd}`,
        currency: "USD",
      }),
    });

    const body = await r.text();
    console.log(`  Status: ${r.status}`);
    console.log(`  Body: ${body.slice(0, 400)}`);
  } catch (e) {
    console.log(`  ❌ fetch fail:`, e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

async function main() {
  for (const t of tests) {
    await chargeOne(t.loc, t.amount, t.label);
  }
}
main();
