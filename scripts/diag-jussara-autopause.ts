/**
 * Diagnóstico do auto-pause F52 da IA da Jussara (2026-07-16).
 * Puxa a conversa REAL do GHL dos contatos pausados e imprime source/userId de
 * cada outbound — pra confirmar se o "humano" que causou o auto-pause é
 * automação (sem source + userId) ou rep de verdade (source="app").
 * Read-only. Roda: npx tsx -r tsconfig-paths/register scripts/diag-jussara-autopause.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";
import { searchConversationsList, getConversationMessages } from "../src/lib/ghl/operations";

const LOCATION = "pGl5pqLLG0QDixANpFnP";
const COMPANY = "TdmQMjj86Y3LgppiB96K";
// contatos pausados (execution_log, auto_pause:human_message:history)
const CONTACTS = ["YmxiYv2jlrIRTWp4cpGL", "0Wi8VFGTkchr1QqRduSF", "ISuRoAZZEWtrq219m1Ju"];

async function main() {
  const ghl = new GHLClient(COMPANY, LOCATION);
  for (const contactId of CONTACTS) {
    console.log(`\n===== contato ${contactId} =====`);
    try {
      const conv = await searchConversationsList(ghl, LOCATION, contactId);
      const cid = conv.conversations?.[0]?.id;
      if (!cid) { console.log("  (sem conversa)"); continue; }
      const res = await getConversationMessages(ghl, cid, LOCATION, 20);
      const msgs = res.messages?.messages || [];
      for (const m of msgs.slice(0, 14)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mm = m as any;
        const dir = m.direction === "inbound" ? "IN " : "OUT";
        const src = mm.source ?? "(sem source)";
        const uid = mm.userId ? `uid:${String(mm.userId).slice(0, 8)}` : "uid:-";
        const mt = m.messageType || "?";
        console.log(`  ${dir} [${src}] ${uid} <${mt}> ${String(m.body || "").replace(/\n/g, " ").slice(0, 70)}`);
      }
    } catch (e) {
      console.log("  ERRO:", e instanceof Error ? e.message : e);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
