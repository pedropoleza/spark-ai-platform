/**
 * Probe READ-ONLY (revisão Marcia 2026-07-28, Frente B): confere tags atuais e
 * appointments dos contatos top-send pra provar (a) remoção da tag de targeting
 * pós-booking e (b) double-booking real vs reschedule.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const CONTACTS = [
  "gzZvGr7NSywBlqziFKxg", // Andrea — booked + 8 targeting_skips depois
  "4IdLxakYOXhtSolJtfEK", // Maria Keown — 2 book_appointment 27s apart
  "0KyU5lvMJr3zIUa3QM1i", // booked + skips
  "6mntS3J88UKMv9Esb8RD", // Valéria — wallet_blocked no meio, sem booking
];

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  for (const cid of CONTACTS) {
    try {
      const c = await client.get<{ contact?: { firstName?: string; lastName?: string; tags?: string[] } }>(
        `/contacts/${cid}`,
      );
      const tags = c.contact?.tags || [];
      console.log(`\n=== ${cid} — ${c.contact?.firstName || "?"} ${c.contact?.lastName || ""}`);
      console.log(`tags: [${tags.join(", ")}]`);
      console.log(`tem 'ai qualification active'? ${tags.map((t) => t.toLowerCase()).includes("ai qualification active")}`);
      const ap = await client.get<{ events?: Array<{ id?: string; startTime?: string; title?: string; appointmentStatus?: string }> }>(
        `/contacts/${cid}/appointments`,
      );
      for (const e of ap.events || []) {
        console.log(`  appt: ${e.startTime} | ${e.appointmentStatus} | ${(e.title || "").slice(0, 60)}`);
      }
      if (!ap.events?.length) console.log("  (sem appointments)");
    } catch (e) {
      console.log(`ERRO ${cid}:`, e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
