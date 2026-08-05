/** READ-ONLY (Pedro 2026-06-19): histórico de envio a contatos-grupo pra descobrir
 * por qual messageType o post chega no grupo. Não envia nada. One-off. */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
const LOC = "RkFnbOYKJvJfBEaU1ycO";
const GROUPS = [
  { name: "comunidade spark grupo", id: "IfqvQvNKKFYmb08TKzjo" },
  { name: "kingdom financial group", id: "PnKYcGDdsTGg6p8cH7N9" },
  { name: "seguro de vida hueberty grupo", id: "x0aw5nCBwWkGUufkXbEI" },
];
async function main() {
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).maybeSingle();
  if (!loc?.company_id) throw new Error("sem company_id");
  const client = new GHLClient(loc.company_id, LOC);
  for (const g of GROUPS) {
    console.log(`\n===== ${g.name} (${g.id}) =====`);
    try {
      const cs = await client.get<{ conversations?: Array<{ id: string }> }>("/conversations/search", { locationId: LOC, contactId: g.id });
      const convs = cs.conversations || [];
      console.log(`conversas: ${convs.length}`);
      for (const c of convs) {
        const r = await client.get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(`/conversations/${c.id}/messages`, { locationId: LOC, limit: "15" });
        const msgs = r.messages?.messages || [];
        for (const m of msgs.slice(0, 12)) {
          const dir = String(m.direction || "").toUpperCase().startsWith("IN") ? "IN " : "OUT";
          console.log(`  [${dir}] type=${m.messageType} status=${m.status || "-"} date=${String(m.dateAdded || "").slice(0, 19)} body="${String(m.body || "").slice(0, 70).replace(/\n/g, " ")}"`);
        }
      }
    } catch (e) {
      console.log("erro:", e instanceof Error ? e.message : e);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
