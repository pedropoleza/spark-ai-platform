/**
 * One-off (Pedro 2026-06-25): prova do falso-negativo de busca de contato.
 * O bot (Sonnet) buscou "Fernanda Lira" e disse "não achei" — mas ela tem tarefa +
 * appointment de recrutamento. Testa o que cada variação de query devolve no GHL,
 * pra isolar se a busca por nome COMPLETO é o culpado vs primeiro-nome/sobrenome.
 *
 * Uso: npx tsx scripts/probe-fernanda-search.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";
import { searchContactsList } from "../src/lib/ghl/operations";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "K9b92VcD0KdCMIn60y0W"; // active location da rep Sabrina (214d1281...)
const QUERIES = ["Fernanda Lira", "Fernanda", "Lira", "fernanda lira", "Fernanda L"];

async function main() {
  const client = new GHLClient(COMPANY, LOC);
  for (const q of QUERIES) {
    try {
      const sr = await searchContactsList(client, LOC, q, 10);
      const contacts = sr.contacts || [];
      const hit = contacts.find((c) =>
        `${c.firstName || ""} ${c.lastName || ""}`.toLowerCase().includes("fernanda"),
      );
      console.log(
        `\n[query="${q}"] → ${contacts.length} resultado(s)` +
          (hit ? ` ✅ Fernanda presente: "${hit.firstName || ""} ${hit.lastName || ""}" (${hit.id}) phone=${hit.phone || "-"}` : " ❌ Fernanda NÃO no resultado"),
      );
      // mostra os 3 primeiros pra entender o ranking
      contacts.slice(0, 3).forEach((c) =>
        console.log(`    - ${c.firstName || ""} ${c.lastName || c.contactName || ""} (${c.id})`),
      );
    } catch (e) {
      console.log(`\n[query="${q}"] → ERRO: ${e instanceof Error ? e.message : e}`);
    }
  }
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
