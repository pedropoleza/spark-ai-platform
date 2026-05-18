// Testa refresh manual de TODOS os tokens NOW (sem esperar cron).
// Roda com: npx tsx -r tsconfig-paths/register scripts/test-refresh-now.ts

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { refreshAllCompanyTokens } from "@/lib/ghl/token-refresher";

async function main() {
  console.log("\n=== Testing refreshAllCompanyTokens() ===\n");
  const r = await refreshAllCompanyTokens();
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
