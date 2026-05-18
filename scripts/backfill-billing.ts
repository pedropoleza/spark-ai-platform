// Backfill 62 records pending — roda chargeUnbilledRecords manualmente
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { chargeUnbilledRecords } from "@/lib/billing/charge";

async function main() {
  console.log("\n=== Backfill billing (chargeUnbilledRecords) ===\n");
  let totalCharged = 0;
  let totalFailed = 0;
  // Roda em loop pra processar todos (50 por batch)
  for (let i = 0; i < 5; i++) {
    const r = await chargeUnbilledRecords();
    console.log(`Round ${i + 1}: charged=${r.charged}, failed=${r.failed}`);
    totalCharged += r.charged;
    totalFailed += r.failed;
    if (r.charged === 0 && r.failed === 0) {
      console.log("Sem mais records pra processar.");
      break;
    }
  }
  console.log(`\nTotal: charged=${totalCharged}, failed=${totalFailed}`);
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
