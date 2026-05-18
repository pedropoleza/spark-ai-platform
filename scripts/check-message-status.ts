// Consulta status dos messageIds enviados no probe anterior
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "H09HtG22LZzTU8htMxxg";

const messages = [
  { name: "WhatsApp + buttons[]", id: "RVHoeedC5koAT0d3Wg2S" },
  { name: "WhatsApp + interactive object", id: "4MKrhqh6s2SQ07v156Wb" },
  { name: "plain WhatsApp baseline", id: "jYQF6rUSiNif4xqQhXBg" },
  { name: "plain SMS (Stevo/Evolution)", id: "U1P4qaYqISgRq9y94OUz" },
];

async function main() {
  const client = new GHLClient(COMPANY, LOC);

  console.log("=== Status de cada mensagem enviada ===\n");
  for (const m of messages) {
    try {
      const r = await client.get<{
        status?: string;
        type?: string;
        messageType?: string;
        body?: string;
        contentType?: string;
        meta?: unknown;
      }>(`/conversations/messages/${m.id}`);
      console.log(`\n${m.name} (${m.id})`);
      console.log(`  status: ${r.status || "?"}`);
      console.log(`  type: ${r.type || r.messageType || "?"}`);
      console.log(`  body: ${(r.body || "").slice(0, 100)}`);
      console.log(`  meta: ${JSON.stringify(r.meta || {}).slice(0, 200)}`);
      console.log(`  full: ${JSON.stringify(r).slice(0, 400)}`);
    } catch (e) {
      console.log(`\n${m.name}: GET FAIL — ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }

  console.log("\n\n=== Conversation Pedro ===");
  try {
    const conv = await client.get<{
      conversation?: { id: string; type?: string; lastMessageType?: string };
    }>(`/conversations/LDRUr7A2ktYHE8vBkCWY`);
    console.log(JSON.stringify(conv, null, 2).slice(0, 500));
  } catch (e) {
    console.log("conv FAIL:", e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

main();
