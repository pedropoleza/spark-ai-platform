/**
 * One-off (Pedro 2026-06-30): investiga por que o SparkBot não responde ao número
 * +1 (754) 299-3931. Busca o contato no hub do SparkBot (Spark Leads) e dumpa a
 * conversa (inbound do rep + qualquer outbound do bot), pra ver se a mensagem
 * chegou e se o bot respondeu algo ("não cadastrado") ou ficou 100% mudo.
 * Uso: npx tsx scripts/probe-sparkbot-phone.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const HUB = "RBFxlEQZobaDjlF2i5px"; // Sparkbot WhatsApp Hub (ativo)
const PHONE_DIGITS = "7542993931";

async function main() {
  const client = new GHLClient(COMPANY, HUB);

  // 1) Acha o contato por telefone (várias variantes de formato)
  const variants = ["+17542993931", "17542993931", "7542993931", "+1 (754) 299-3931"];
  let contact: { id?: string; firstName?: string; lastName?: string; phone?: string } | undefined;
  for (const q of variants) {
    try {
      const r = await client.get<{ contacts?: Array<{ id: string; firstName?: string; lastName?: string; phone?: string }> }>(
        "/contacts/", { locationId: HUB, query: q },
      );
      const hit = (r.contacts || []).find((c) => (c.phone || "").replace(/\D/g, "").includes(PHONE_DIGITS));
      if (hit) { contact = hit; break; }
    } catch (e) { console.log(`  busca "${q}" erro: ${e instanceof Error ? e.message : e}`); }
  }

  if (!contact?.id) {
    console.log(`\n❌ NENHUM contato com ${PHONE_DIGITS} no hub ${HUB}.`);
    console.log("   → A mensagem do rep NÃO criou contato no hub do SparkBot.");
    console.log("   → Provável: chegou pelo Stevo direto, identifyRep=null, dropado em silêncio (sem contato GHL).");
    return;
  }

  const name = `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || contact.id;
  console.log(`\n✅ Contato: ${name} (${contact.id}) phone=${contact.phone}`);

  // 2) Dumpa a conversa
  const cs = await client.get<{ conversations?: Array<{ id: string }> }>("/conversations/search", { locationId: HUB, contactId: contact.id });
  console.log(`   ${cs.conversations?.length || 0} conversa(s)\n`);
  for (const cv of cs.conversations || []) {
    const m = await client.get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(`/conversations/${cv.id}/messages`, { limit: 100 });
    const list = (m.messages?.messages || []).slice().sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)));
    for (const msg of list) {
      const body = String(msg.body || msg.message || "").replace(/\s+/g, " ").trim();
      const who = msg.direction === "inbound" ? "REP  " : "BOT  ";
      const when = new Date(String(msg.dateAdded)).toLocaleString("pt-BR", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" });
      console.log(`  [${when}] ${who}| ${body.slice(0, 400) || "(vazio/anexo)"}`);
    }
  }
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
