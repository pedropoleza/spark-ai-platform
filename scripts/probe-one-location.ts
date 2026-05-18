// Probe específico — testa 1 location com detalhes completos
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { getLocationToken, invalidateTokenCache, getCompanyToken } from "@/lib/ghl/auth";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = process.argv[2] || "dF2FDDZzSv715e1av4gr";

async function main() {
  console.log(`\n=== Probe ${LOC} (company=${COMPANY}) ===\n`);

  // 1. Company token
  try {
    const ct = await getCompanyToken(COMPANY);
    console.log(`✓ Company token OK (length=${ct.access_token.length})`);
  } catch (e) {
    console.log(`✗ Company token FAIL: ${e instanceof Error ? e.message : e}`);
    return;
  }

  // 2. Invalida cache
  invalidateTokenCache(COMPANY, LOC);
  console.log("✓ Cache invalidado");

  // 3. Tenta gerar location token
  try {
    const token = await getLocationToken(COMPANY, LOC);
    console.log(`\n✅ LOCATION TOKEN OK!`);
    console.log(`   Length: ${token.length}`);
    console.log(`   Primeiros 30 chars: ${token.slice(0, 30)}...`);
  } catch (e) {
    console.log(`\n❌ LOCATION TOKEN FAIL: ${e instanceof Error ? e.message : e}`);
    return;
  }

  // 4. Teste real — chama 1 endpoint que falhou no signal (get_contact_notes)
  // O signal foi 403 nesse endpoint. Vamos validar se já funciona.
  try {
    const { GHLClient } = await import("@/lib/ghl/client");
    const client = new GHLClient(COMPANY, LOC);
    const contacts = await client.get<{ contacts?: Array<{ id: string; name?: string }> }>("/contacts/", {
      locationId: LOC,
      limit: "1",
    });
    const count = (contacts.contacts || []).length;
    console.log(`\n✓ Teste real /contacts/ OK — retornou ${count} contato(s)`);
  } catch (e) {
    console.log(`\n⚠️  Teste /contacts/ falhou: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }
}

main();
