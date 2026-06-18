import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "../src/lib/ghl/client";
async function main() {
  const c = new GHLClient("TdmQMjj86Y3LgppiB96K", "efZEjK6PqtPGDHqB2vV6");
  try {
    const r = await c.get<{ contacts?: Array<{ id: string; firstName?: string }> }>(
      "/contacts/", { locationId: "efZEjK6PqtPGDHqB2vV6", query: "Thais", limit: "2" });
    console.log(`✅ GHL OK — search_contacts retornou ${ (r.contacts||[]).length } contato(s). Token funcionando.`);
  } catch (e) {
    console.log(`❌ ainda falhando: ${e instanceof Error ? e.message.slice(0,160) : e}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
