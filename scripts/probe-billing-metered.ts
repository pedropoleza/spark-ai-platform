// Teste do novo schema metered billing com IDs reais
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { getLocationToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const APP_ID = "67cf4ed48fa066a72e313796";
const METER_ID = "6a0a5fa1242130a40f274e87";

// Testa em 3 locations com pending
const tests = [
  { loc: "b1ttBRVEnm5joFvP2UXO", label: "Gustavo" },
  { loc: "dF2FDDZzSv715e1av4gr", label: "rep +15612" },
  { loc: "K9b92VcD0KdCMIn60y0W", label: "rep +17326" },
];

async function chargeOne(loc: string, label: string) {
  console.log(`\n=== ${label} (${loc}) ===`);
  const token = await getLocationToken(COMPANY, loc);

  const eventId = `probe-${Date.now()}-${loc.slice(0, 6)}`;
  const amountUsd = 0.01; // $0.01 teste

  // Variação 1: units=1 + price dinâmico
  console.log("\n--- Variação A: units=1, price=$0.01 (dynamic) ---");
  try {
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
        eventId: eventId + "-a",
        companyId: COMPANY,
        locationId: loc,
        units: 1,
        price: amountUsd,
        description: "[PROBE] Spark AI test charge",
      }),
    });
    const body = await r.text();
    console.log(`Status: ${r.status}`);
    console.log(`Body: ${body.slice(0, 500)}`);
  } catch (e) {
    console.log(`fetch fail: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }

  // Se rejeitar, tenta variação B: sem price (usa default $0.05)
  console.log("\n--- Variação B: units=1 só (sem price, usa default) ---");
  try {
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
        eventId: eventId + "-b",
        companyId: COMPANY,
        locationId: loc,
        units: 1,
        description: "[PROBE] Spark AI test charge",
      }),
    });
    const body = await r.text();
    console.log(`Status: ${r.status}`);
    console.log(`Body: ${body.slice(0, 500)}`);
  } catch (e) {
    console.log(`fetch fail: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }
}

async function main() {
  // Testa só 1 location primeiro (Gustavo) pra ver schema
  await chargeOne(tests[0].loc, tests[0].label);
}
main();
