// Pega payload completo de uma msg + lista providers da location
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "H09HtG22LZzTU8htMxxg";

async function main() {
  const client = new GHLClient(COMPANY, LOC);

  // 1. Full payload de uma msg
  console.log("=== Full message payload (mostra erro completo) ===\n");
  for (const id of ["jYQF6rUSiNif4xqQhXBg", "U1P4qaYqISgRq9y94OUz"]) {
    try {
      const r = await client.get(`/conversations/messages/${id}`);
      console.log(`\n${id}:`);
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.log(`${id} FAIL:`, e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }

  // 2. Providers configurados (phone numbers, integrations)
  console.log("\n\n=== Conversation Providers ===");
  try {
    const providers = await client.get<{ providers?: unknown[] }>(
      "/conversations/providers/",
      { locationId: LOC },
    );
    console.log(JSON.stringify(providers, null, 2).slice(0, 2000));
  } catch (e) {
    console.log("providers FAIL:", e instanceof Error ? e.message.slice(0, 200) : e);
  }

  // 3. Phone numbers / Twilio account
  console.log("\n\n=== Phone Numbers ===");
  try {
    const phones = await client.get(`/phone-system/numbers/`, { locationId: LOC });
    console.log(JSON.stringify(phones, null, 2).slice(0, 1000));
  } catch (e) {
    console.log("phones FAIL:", e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

main();
