/**
 * Varredura final: agenda da semana (14-20 jun) + oportunidade da Catlin/Pablo.
 *   npx tsx -r tsconfig-paths/register scripts/probe-find-contacts.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "../src/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "efZEjK6PqtPGDHqB2vV6";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);

  console.log("=== AGENDA Demo (14-20 jun) ===");
  const cal = await client.get<{ calendars?: Array<{ id: string; name?: string }> }>("/calendars/", { locationId: LOCATION });
  const demo = (cal.calendars || []).find((c) => /demo/i.test(c.name || ""));
  const start = new Date("2026-06-14T00:00:00-04:00").getTime();
  const end = new Date("2026-06-20T23:59:59-04:00").getTime();
  const ev = await client.get<{ events?: Array<{ title?: string; startTime?: string }> }>("/calendars/events", { locationId: LOCATION, calendarId: demo!.id, startTime: String(start), endTime: String(end) });
  for (const e of (ev.events || []).sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""))) console.log(`  ${e.startTime} | ${e.title}`);

  console.log("\n=== OPORTUNIDADE Catlin / Pablo ? ===");
  for (const [label, phone] of [["Catlin", "8572372439"], ["Pablo", "5083716240"]] as [string, string][]) {
    const r = await client.get<{ contacts?: Array<{ id: string }> }>("/contacts/", { locationId: LOCATION, query: phone, limit: "1" });
    const cid = (r.contacts || [])[0]?.id;
    if (!cid) { console.log(`  ${label}: contato não achado`); continue; }
    try {
      const opp = await client.get<{ opportunities?: Array<{ name?: string; pipelineStageId?: string }> }>("/opportunities/search", { location_id: LOCATION, contact_id: cid });
      const os = opp.opportunities || [];
      console.log(`  ${label} (${cid}): ${os.length ? os.map((o) => o.name).join(", ") : "❌ SEM oportunidade"}`);
    } catch (e) { console.log(`  ${label}: opp search falhou ${e instanceof Error ? e.message.slice(0, 50) : e}`); }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
