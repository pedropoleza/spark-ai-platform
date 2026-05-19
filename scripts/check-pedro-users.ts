import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

async function main() {
  const c = new GHLClient("TdmQMjj86Y3LgppiB96K", "efZEjK6PqtPGDHqB2vV6");
  const r = await c.get<{ users?: Array<{ id: string; firstName?: string; lastName?: string; email?: string }> }>(
    "/users/",
    { locationId: "efZEjK6PqtPGDHqB2vV6" },
  );
  console.log("Users na location Spark Leads (efZEjK6PqtPGDHqB2vV6):\n");
  for (const u of r.users || []) {
    console.log(`  ${u.id} — ${u.firstName || ""} ${u.lastName || ""} <${u.email || "no-email"}>`);
  }
}
main();
