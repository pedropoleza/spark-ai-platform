import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

async function main() {
  const c = new GHLClient("TdmQMjj86Y3LgppiB96K", "RBFxlEQZobaDjlF2i5px");
  const convId = "KpSbvtUeoy2tLpBBvEoT"; // conversa Pedro na Hub

  const r = await c.get<{
    messages?: { messages?: Array<{
      id: string; direction: string; body?: string; messageType?: string;
      contentType?: string; dateAdded: string; attachments?: unknown[];
      meta?: unknown;
    }> };
  }>(`/conversations/${convId}/messages`, { locationId: "RBFxlEQZobaDjlF2i5px", limit: "40" });

  const msgs = r.messages?.messages || [];
  console.log(`Total mensagens na conversa: ${msgs.length}\n`);
  console.log("Inbound de 00:08-00:55 UTC (= 20:08-20:55 EDT):\n");

  for (const m of msgs) {
    const t = new Date(m.dateAdded).getTime();
    const lo = new Date("2026-05-20T00:08:00Z").getTime();
    const hi = new Date("2026-05-20T00:56:00Z").getTime();
    if (m.direction !== "inbound" || t < lo || t > hi) continue;
    const edt = new Date(m.dateAdded).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const hasAtt = Array.isArray(m.attachments) && m.attachments.length > 0;
    console.log(`[${edt} EDT] type=${m.messageType} ct=${m.contentType || "?"}`);
    console.log(`  body: "${(m.body || "").slice(0, 60)}"`);
    console.log(`  attachments: ${hasAtt ? JSON.stringify(m.attachments).slice(0, 200) : "❌ NENHUM"}`);
    console.log("");
  }
}
main();
