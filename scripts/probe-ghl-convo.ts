/**
 * F55 probe: busca as mensagens da conversa GHL de um contato pra entender por
 * que o F52 (anti-eco) falso-pausou. Mostra direction + body de cada msg.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const CONTACT_ID = "1sfbr5EiFJ8jvoGxE2nO";

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  const search = await client.get<{ conversations?: { id: string }[] }>(
    "/conversations/search", { locationId: LOCATION_ID, contactId: CONTACT_ID },
  );
  const convId = search.conversations?.[0]?.id;
  console.log("convId:", convId);
  if (!convId) { console.log("sem conversa"); process.exit(0); }

  const msgs = await client.get<{ messages?: { messages?: Array<{ direction?: string; body?: string; messageType?: string; dateAdded?: string }> } }>(
    `/conversations/${convId}/messages`, { locationId: LOCATION_ID },
  );
  const list = (msgs.messages?.messages || [])
    .sort((a, b) => new Date(a.dateAdded || 0).getTime() - new Date(b.dateAdded || 0).getTime());
  console.log(`\n${list.length} mensagens na conversa GHL (mais recentes no fim):\n`);
  for (const m of list.slice(-12)) {
    const dir = (m.direction || "?").padEnd(8);
    const body = (m.body || "(vazio)").replace(/\n/g, " ").slice(0, 90);
    console.log(`[${dir}] ${m.messageType || "?"} | ${body}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
