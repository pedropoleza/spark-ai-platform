/** READ-ONLY (Pedro 2026-06-19): acha a conversa do SparkBot com a Jussara
 * (689-203-3343 / 321-276-8361) no hub + na location dela, e lê o histórico
 * pra diagnosticar o erro de envio dos Termos. Não envia nada. One-off. */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATIONS = ["RBFxlEQZobaDjlF2i5px", "pGl5pqLLG0QDixANpFnP"];
const QUERIES = ["Jussara", "203-3343", "6892033343", "2768361"];

async function main() {
  const sb = createAdminClient();
  const { data: locs } = await sb.from("locations").select("location_id, company_id").in("location_id", LOCATIONS);
  const compById = new Map((locs || []).map((l) => [l.location_id, l.company_id]));

  for (const loc of LOCATIONS) {
    const company = compById.get(loc);
    if (!company) continue;
    const client = new GHLClient(company, loc);
    console.log(`\n############ LOCATION ${loc} ############`);
    const found = new Map<string, Record<string, unknown>>();
    for (const q of QUERIES) {
      try {
        const r = await client.get<{ contacts?: Array<Record<string, unknown>> }>("/contacts/", { locationId: loc, query: q, limit: "20" });
        for (const c of r.contacts || []) {
          const blob = `${c.firstName || ""} ${c.lastName || ""} ${c.phone || ""} ${c.email || ""}`.toLowerCase();
          if (blob.includes("jussara") || String(c.phone || "").includes("3343") || String(c.phone || "").includes("2768361")) {
            found.set(String(c.id), c);
          }
        }
      } catch (e) { console.log(`  query "${q}" erro:`, e instanceof Error ? e.message : e); }
    }
    console.log(`contatos candidatos: ${found.size}`);
    for (const c of found.values()) {
      console.log(`\n--- contato: ${c.firstName || ""} ${c.lastName || ""} | phone=${c.phone} | email=${c.email || "-"} | id=${c.id} ---`);
      try {
        const cs = await client.get<{ conversations?: Array<{ id: string; lastMessageDate?: string }> }>("/conversations/search", { locationId: loc, contactId: String(c.id) });
        const convs = cs.conversations || [];
        console.log(`  conversas: ${convs.length}`);
        for (const cv of convs) {
          const r = await client.get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(`/conversations/${cv.id}/messages`, { locationId: loc, limit: "40" });
          const msgs = (r.messages?.messages || []).sort((a, b) => new Date(String(a.dateAdded||0)).getTime() - new Date(String(b.dateAdded||0)).getTime());
          for (const m of msgs) {
            const dir = String(m.direction || "").toUpperCase().startsWith("IN") ? "← JUSSARA" : "→ BOT/NÓS";
            const when = String(m.dateAdded || "").slice(0, 19);
            console.log(`   [${when}] ${dir} type=${m.messageType} status=${m.status||"-"} :: ${String(m.body || "").slice(0,120).replace(/\n/g," ")}`);
          }
        }
      } catch (e) { console.log("  erro convo:", e instanceof Error ? e.message : e); }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
