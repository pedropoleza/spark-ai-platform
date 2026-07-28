/**
 * Probe efêmero 2/2 (rodada 2 Marcia) — READ-ONLY.
 * Pagina TODA a conversa GHL da Narjara (M7ykLVTYLRpyQUah6Ea9) pra achar o
 * período em que uma IA (nossa ou N8n) mandou mensagem, com datas.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const CONV_ID = "M7ykLVTYLRpyQUah6Ea9";

type Msg = { id?: string; direction?: string; body?: string; messageType?: string; dateAdded?: string; source?: string };

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  const all: Msg[] = [];
  let lastId: string | undefined;
  for (let page = 0; page < 12; page++) {
    const params: Record<string, string | number> = { locationId: LOCATION_ID, limit: 100 };
    if (lastId) params.lastMessageId = lastId;
    const res = await client.get<{ messages?: { messages?: Msg[]; lastMessageId?: string; nextPage?: boolean } }>(
      `/conversations/${CONV_ID}/messages`, params,
    );
    const batch = res.messages?.messages || [];
    if (batch.length === 0) break;
    all.push(...batch);
    lastId = res.messages?.lastMessageId || batch[batch.length - 1]?.id;
    if (res.messages?.nextPage === false) break;
  }
  const sorted = all.sort((a, b) => new Date(a.dateAdded || 0).getTime() - new Date(b.dateAdded || 0).getTime());
  console.log(`TOTAL: ${sorted.length} mensagens\n`);
  for (const m of sorted) {
    const dir = String(m.direction || "?").padEnd(8);
    const body = String(m.body || "(vazio)").replace(/\n/g, " ⏎ ").slice(0, 170);
    console.log(`[${m.dateAdded}] [${dir}] ${m.messageType || "?"} | ${body}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
