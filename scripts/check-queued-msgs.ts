import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "RBFxlEQZobaDjlF2i5px";

const ids = [
  { name: "WhatsApp + buttons[]", id: "Fe3f4QbA5FxWaAFlfngR" },
  { name: "WhatsApp + interactive", id: "dvfZrfS1aieyQo1QcHIF" },
];

async function main() {
  const client = new GHLClient(COMPANY, LOC);
  console.log("=== Status final + payload completo dos 2 queued ===\n");
  for (const m of ids) {
    try {
      const r = await client.get<{
        message?: { status?: string; error?: string; meta?: unknown; body?: string; type?: number };
      }>(`/conversations/messages/${m.id}`);
      console.log(`\n${m.name} (${m.id}):`);
      console.log(JSON.stringify(r.message, null, 2));
    } catch (e) {
      console.log(`${m.name} FAIL:`, e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }

  // Confere phone Hub
  console.log("\n=== Conversation providers da Hub ===");
  try {
    const r = await client.get<{ providers?: unknown[] }>(`/conversations/providers/`, {
      locationId: LOC,
    });
    console.log(JSON.stringify(r, null, 2).slice(0, 2000));
  } catch (e) {
    console.log("providers FAIL:", e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

main();
