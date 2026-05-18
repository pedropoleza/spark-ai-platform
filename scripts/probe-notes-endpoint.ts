import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

async function main() {
  const client = new GHLClient("TdmQMjj86Y3LgppiB96K", "dF2FDDZzSv715e1av4gr");
  try {
    const r = await client.get<{ notes?: unknown[] }>(
      "/contacts/ErpM2X8vR1U4IrRTZnKX/notes/",
    );
    console.log("✅ NOTES endpoint OK");
    console.log("   notes count:", (r.notes || []).length);
  } catch (e) {
    console.log("❌ NOTES FAIL:", e instanceof Error ? e.message.slice(0, 300) : e);
  }
}
main();
