import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const IDS = ["A8H9l75B81nFzyvti7EJ","lVohHuZSLQPeCBk6V2nQ","tRVxF9uhlCC70amVA0hs","8Bl9dezXjFA4u2f64Lyc"];
async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  const client = new GHLClient(loc!.company_id, LOCATION_ID);
  for (const cid of IDS) {
    try {
      const c = await client.get<{ contact?: { firstName?: string; tags?: string[] } }>(`/contacts/${cid}`);
      console.log(`${cid} | ${c.contact?.firstName} | tags: [${(c.contact?.tags||[]).join(", ")}]`);
    } catch (e) { console.log(`${cid} ERRO`, e instanceof Error ? e.message.slice(0,120) : e); }
  }
  process.exit(0);
}
main();
