/**
 * Corrige a pendência dropada: cria Rafaela Olimpio + marca demo seg 15/jun 11h.
 *   npx tsx -r tsconfig-paths/register scripts/exec-rafaela.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { executeTool } from "../src/lib/account-assistant/tools";
import type { ToolContext } from "../src/lib/account-assistant/tools/types";

const REP_ID = "1eeb02cc-1a48-4b56-b177-52dcbca07ac2";
const LOCATION = "efZEjK6PqtPGDHqB2vV6";
const COMPANY = "TdmQMjj86Y3LgppiB96K";
const PHONE = "+12404497099";

async function main() {
  const supabase = createAdminClient();
  const { data: rep } = await supabase.from("rep_identities").select("*").eq("id", REP_ID).single();
  const ghlClient = new GHLClient(COMPANY, LOCATION);
  const ctx: ToolContext = { rep: rep as ToolContext["rep"], locationId: LOCATION, companyId: COMPANY, ghlClient, testSessionId: null, confirmationMode: "high_only" };

  // 1) garante contato
  let cid = (await executeTool("search_contacts", { query: PHONE.replace("+", "") }, ctx)).data as { contacts?: Array<{ id: string }> };
  let contactId = (cid?.contacts || [])[0]?.id;
  if (!contactId) {
    const c = await executeTool("create_contact", { first_name: "Rafaela", last_name: "Olimpio", phone: PHONE, source: "Convenção 13/jun" }, ctx);
    contactId = (c.data as { contact?: { id?: string }; id?: string })?.contact?.id || (c.data as { id?: string })?.id;
    console.log(`contato: ${c.status === "ok" ? "✅ criado " + contactId : "❌ " + c.message}`);
  } else {
    console.log(`contato: já existe ${contactId}`);
  }
  if (!contactId) { console.log("sem contactId, abortando appt"); process.exit(1); }

  // 2) calendário Demo + marca seg 15/jun 11h
  const cal = await ghlClient.get<{ calendars?: Array<{ id: string; name?: string }> }>("/calendars/", { locationId: LOCATION });
  const demo = (cal.calendars || []).find((c) => /demo/i.test(c.name || ""));
  const r = await executeTool("create_appointment", {
    calendar_id: demo!.id, contact_id: contactId,
    start_time: "2026-06-15T11:00:00-04:00", end_time: "2026-06-15T11:30:00-04:00",
    title: "Demo - Rafaela Olimpio", confirmed_by_rep: true,
  }, ctx);
  console.log(`demo seg 15/jun 11h: ${r.status === "ok" ? "✅ marcada" : "❌ " + r.message}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
