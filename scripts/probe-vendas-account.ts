/**
 * One-off (Pedro 2026-06-29): lê as conversas REAIS do agente de vendas da location
 * oEEbKRN0rQHdee13Bn1u (lead + bot, do GHL) pra avaliar qualidade/inconsistências.
 * Uso: npx tsx scripts/probe-vendas-account.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "oEEbKRN0rQHdee13Bn1u";
const CONTACTS = "Hlh05QRRlWw2GEPYCSJd,HrglmqkMIGOCRGuocgv3,jMKhxHtzAZEhgYmr0Vbv,qszFe8t5T1mBujSiHR3c,sWTG2HDkKgn3rh9CFScj,ZWPi45vmtYuKNB9OTJl1".split(",");

async function dump(client: GHLClient, contactId: string) {
  let name = contactId;
  try {
    const c = await client.get<{ contact?: { firstName?: string; lastName?: string; phone?: string } }>(`/contacts/${contactId}`);
    name = `${c.contact?.firstName || ""} ${c.contact?.lastName || ""}`.trim() || contactId;
  } catch { /* ignore */ }

  const cs = await client.get<{ conversations?: Array<{ id: string }> }>("/conversations/search", { locationId: LOC, contactId });
  console.log(`\n\n========== CONTATO: ${name} (${contactId}) — ${cs.conversations?.length || 0} conversa(s) ==========`);
  for (const cv of cs.conversations || []) {
    const m = await client.get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(`/conversations/${cv.id}/messages`, { limit: 100 });
    const list = (m.messages?.messages || []).slice().sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)));
    for (const msg of list) {
      const body = String(msg.body || msg.message || "").replace(/\s+/g, " ").trim();
      if (!body) continue;
      const who = msg.direction === "inbound" ? "LEAD " : "BOT  ";
      const when = new Date(String(msg.dateAdded)).toLocaleString("pt-BR", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" });
      console.log(`  [${when}] ${who}| ${body.slice(0, 500)}`);
    }
  }
}

async function main() {
  const client = new GHLClient(COMPANY, LOC);
  for (const c of CONTACTS) {
    try { await dump(client, c); }
    catch (e) { console.log(`\n### ${c}: ERRO ${e instanceof Error ? e.message : e}`); }
  }
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
