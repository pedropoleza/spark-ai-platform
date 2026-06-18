/**
 * Probe live-debug 2026-06-12: resolve nome/tags/assignedTo de uma lista de
 * contact_ids no GHL (pra mapear quem é quem num incidente de "não respondeu").
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/probe-contacts-names.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";

const LOCATION = "jA6uzx6tONyTeocxw4Cj"; // Five Star Ricos
const COMPANY = "TdmQMjj86Y3LgppiB96K";
const IDS = [
  "LlztTquUPu3tzlfbM6dv", // targeting_skip 02:18
  "1bJIVPeW8c4Uc48S7Fmh", // ai_paused 21:54
  "1sfbr5EiFJ8jvoGxE2nO", // ai_paused 14:16
  "nNv4dAWHvS0RnbkbchSU", // ai_paused 13:31
  "Nn50FVVZENkGCXDwrA0O",
  "X4VoApMTE8l1QL5PViKV",
];

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  for (const id of IDS) {
    try {
      const r = await client.get<{ contact?: { firstName?: string; lastName?: string; name?: string; tags?: string[]; assignedTo?: string } }>(`/contacts/${id}`);
      const c = r.contact || {};
      const name = c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim();
      console.log(`${id}  →  "${name}"  | assignedTo=${c.assignedTo || "(none)"} | tags=[${(c.tags || []).join(", ")}]`);
    } catch (e) {
      console.log(`${id}  →  ERRO: ${e instanceof Error ? e.message.slice(0, 90) : e}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
