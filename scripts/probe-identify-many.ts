/**
 * Probe READ-ONLY: replica a varredura do identifyRep pra +19544771397 SEM o
 * side-effect de criar rep. Mostra, por location, se o /users/ do GHL é
 * alcançável (token emite) e se algum user bate o telefone dela.
 * Foco na teMEo (onde o Pedro diz que ela é user) + o hub RBFx.
 *   npx tsx -r tsconfig-paths/register scripts/probe-identify-many.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { normalizePhone } from "../src/lib/account-assistant/identity";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const TARGET = "+19544771397";

async function scan(company: string, loc: string) {
  try {
    const c = new GHLClient(company, loc);
    const res = await c.get<{ users?: Array<{ id: string; firstName?: string; lastName?: string; phone?: string }> }>(
      "/users/", { locationId: loc });
    const users = res.users || [];
    const match = users.find((u) => normalizePhone(u.phone || "") === TARGET);
    console.log(`  ${loc}: ✅ /users/ OK (${users.length} users)${match ? ` — MATCH: ${match.firstName} ${match.lastName || ""} (${match.id}) phone=${match.phone}` : " — sem match do telefone"}`);
    return !!match;
  } catch (e) {
    console.log(`  ${loc}: ❌ /users/ FALHOU — ${e instanceof Error ? e.message.slice(0, 140) : e}`);
    return false;
  }
}

async function main() {
  console.log(`Procurando GHL user com phone ${TARGET}`);
  console.log("\n=== teMEo (onde Pedro diz que ela é user) + hub RBFx ===");
  const inTeMEo = await scan(COMPANY, "teMEo79wTnlqgUgDRmaX");
  await scan(COMPANY, "RBFxlEQZobaDjlF2i5px");
  console.log(inTeMEo ? "\n→ ela É user na teMEo (identifyRep deveria achar)" : "\n→ ela NÃO é user achável na teMEo (ou /users/ falhou)");
  process.exit(0);
}
main().catch((e) => { console.error("erro:", e instanceof Error ? e.message : e); process.exit(1); });
