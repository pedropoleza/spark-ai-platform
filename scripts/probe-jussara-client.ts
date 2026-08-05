/**
 * One-off (Pedro 2026-06-24): resolve o contato +12674906796 na location da
 * Jussara (pGl5pqLLG0QDixANpFnP) e puxa a conversa real do GHL pra ver qual
 * mensagem o SparkBot mandou e quando (caso "pediu pra cancelar e ele enviou").
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";
import { searchContactsList } from "../src/lib/ghl/operations";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "pGl5pqLLG0QDixANpFnP";
// Os DOIS Vitor: o Albuquerque que o Pedro perguntou + o do fluxo no-show.
const PHONES = ["+12674906796", "+16098507781"];
// Texto que o bot AFIRMOU ter enviado pro Vitor Albuquerque.
const NEEDLES = ["conseguiu responder", "quest", "aplica", "podemos come", "podem come"];

async function dumpContact(client: GHLClient, phone: string) {
  const sr = await searchContactsList(client, LOC, phone, 10);
  const contacts = sr.contacts || [];
  const want = phone.replace(/\D/g, "").slice(-10);
  const contact = contacts.find((c) => String(c.phone || "").replace(/\D/g, "").endsWith(want)) || contacts[0];
  if (!contact) { console.log(`\n### ${phone}: contato não encontrado`); return; }
  console.log(`\n############ ${phone} → ${contact.firstName || ""} ${contact.lastName || contact.contactName || ""} (${contact.id}) tags=${JSON.stringify(contact.tags || [])}`);

  const convSearch = await client.get<{ conversations?: Array<{ id: string; lastMessageDate?: string }> }>(
    "/conversations/search", { locationId: LOC, contactId: contact.id as string },
  );
  for (const cv of convSearch.conversations || []) {
    const msgs = await client.get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(
      `/conversations/${cv.id}/messages`, { limit: 100 },
    );
    const list = (msgs.messages?.messages || []).slice();
    list.sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)));
    // Só mostra outbound 06-22 (dia do incidente) + qualquer msg que bata os needles.
    let hitNeedle = false;
    for (const m of list) {
      const body = String(m.body || m.message || "").replace(/\s+/g, " ").trim();
      const low = body.toLowerCase();
      const isHit = NEEDLES.some((n) => low.includes(n));
      const when = new Date(String(m.dateAdded)).toLocaleString("pt-BR", { timeZone: "America/New_York" });
      const day = String(m.dateAdded).slice(0, 0); // noop
      const isOut = m.direction === "outbound";
      if (isHit) hitNeedle = true;
      if (isHit) {
        console.log(`  ${isOut ? "→ ENVIADO" : "← recebido"} [${when}] ⭐NEEDLE :: ${body.slice(0, 200)}`);
      }
    }
    console.log(`  (conversa ${cv.id}: ${list.length} msgs; "Você conseguiu responder as questões..." apareceu? ${hitNeedle ? "SIM" : "NÃO"})`);
  }
}

async function main() {
  const client = new GHLClient(COMPANY, LOC);
  for (const p of PHONES) await dumpContact(client, p);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
