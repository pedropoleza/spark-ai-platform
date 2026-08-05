/**
 * Read-only probe (pesquisa API 2026-07-10): compara GET /calendars/events vs
 * GET /calendars/blocked-slots pra ver se bloqueios do Google Calendar (busy
 * sync) aparecem, com que shape (title? assignedUserId? calendarId?).
 *   npx tsx -r tsconfig-paths/register scripts/probe-blocked-slots.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
// Locations conhecidas dos scripts one-off (Jussara, Manuela, Marina, vendas)
const LOCS = [
  "pGl5pqLLG0QDixANpFnP", // Jussara
  "teMEo79wTnlqgUgDRmaX", // Manuela
  "A62s5EQj1hldOuvBEowv", // Marina
  "oEEbKRN0rQHdee13Bn1u", // vendas
];

async function probeLoc(loc: string) {
  const client = new GHLClient(COMPANY, loc);
  const start = Date.now() - 2 * 86400_000;
  const end = Date.now() + 14 * 86400_000;
  console.log(`\n======== LOCATION ${loc} ========`);
  let cals: Array<{ id: string; name?: string; teamMembers?: Array<{ userId?: string }> }> = [];
  try {
    const res = await client.get<{ calendars?: typeof cals }>("/calendars/", { locationId: loc });
    cals = res.calendars || [];
  } catch (e) {
    console.log("  /calendars/ ERRO:", e instanceof Error ? e.message : e);
    return;
  }
  const userIds = new Set<string>();
  for (const c of cals) for (const tm of c.teamMembers || []) if (tm.userId) userIds.add(tm.userId);
  console.log(`  calendars=${cals.length} users(teamMembers)=${userIds.size}`);

  for (const userId of Array.from(userIds).slice(0, 6)) {
    const params = { locationId: loc, userId, startTime: String(start), endTime: String(end) };
    let evs: Array<Record<string, unknown>> = [];
    let blocks: Array<Record<string, unknown>> = [];
    try {
      const r = await client.get<{ events?: typeof evs }>("/calendars/events", params);
      evs = r.events || [];
    } catch (e) {
      console.log(`  user=${userId} /events ERRO:`, e instanceof Error ? e.message.slice(0, 120) : e);
    }
    try {
      const r = await client.get<{ events?: typeof blocks }>("/calendars/blocked-slots", params);
      blocks = r.events || [];
    } catch (e) {
      console.log(`  user=${userId} /blocked-slots ERRO:`, e instanceof Error ? e.message.slice(0, 120) : e);
    }
    console.log(`  user=${userId}: events=${evs.length} blocked=${blocks.length}`);
    for (const b of blocks.slice(0, 4)) {
      console.log("    BLOCK sample:", JSON.stringify(b));
    }
    // events sem contactId podem ser blocks/google — mostra amostra
    const weird = evs.filter((e) => !e.contactId).slice(0, 3);
    for (const w of weird) console.log("    EVENT sem contactId:", JSON.stringify(w).slice(0, 400));
  }
}

async function main() {
  for (const loc of LOCS) await probeLoc(loc);
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
