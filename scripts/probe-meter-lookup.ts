import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { getLocationToken, getCompanyToken } from "@/lib/ghl/auth";
import { GHL_API_BASE } from "@/lib/utils/constants";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const APP_ID = "67cf4ed48fa066a72e313796";
const METER_ID = "6a0a5fa1242130a40f274e87";

async function tryEndpoint(path: string, useCompanyToken = false) {
  let token: string;
  if (useCompanyToken) {
    const ct = await getCompanyToken(COMPANY);
    token = ct.access_token;
  } else {
    token = await getLocationToken(COMPANY, "H09HtG22LZzTU8htMxxg");
  }
  try {
    const r = await fetch(`${GHL_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    });
    const body = await r.text();
    console.log(`[${useCompanyToken ? "COMPANY" : "LOCATION"} token] ${path}`);
    console.log(`  Status: ${r.status}`);
    console.log(`  Body: ${body.slice(0, 400)}`);
  } catch (e) {
    console.log(`FAIL ${path}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }
  console.log("");
}

async function main() {
  // Tenta vários paths comuns pra info do meter / app pricing
  for (const t of [false, true]) {
    await tryEndpoint(`/marketplace/billing/meters`, t);
    await tryEndpoint(`/marketplace/billing/meters/${METER_ID}`, t);
    await tryEndpoint(`/marketplace/app/${APP_ID}`, t);
    await tryEndpoint(`/marketplace/app/${APP_ID}/pricing`, t);
  }
}
main();
