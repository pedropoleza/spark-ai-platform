/**
 * Probe: contato "Many" (954-477-1397, Pfx1aJ...) no hub RBFx — o GHL devolve
 * o phone? (webhook-handler ignora em silêncio se contact.phone for null).
 *   npx tsx -r tsconfig-paths/register scripts/probe-many-contact.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "../src/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const HUB = "RBFxlEQZobaDjlF2i5px";
const CONTACT = "Pfx1aJdVRXY1B1V96mhu";

async function main() {
  const c = new GHLClient(COMPANY, HUB);
  const r = await c.get<{ contact?: Record<string, unknown> }>(`/contacts/${CONTACT}`);
  const ct = r.contact || {};
  console.log("phone:", JSON.stringify(ct.phone));
  console.log("firstName:", ct.firstName, "| lastName:", ct.lastName);
  console.log("country:", ct.country, "| timezone:", ct.timezone);
  console.log("type:", ct.type, "| source:", ct.source);
  // campos que possam conter o número alternativo
  const cf = (ct.customFields as Array<{ id: string; value: unknown }> | undefined) || [];
  console.log("customFields count:", cf.length);
  process.exit(0);
}
main().catch((e) => { console.error("probe erro:", e instanceof Error ? e.message : e); process.exit(1); });
