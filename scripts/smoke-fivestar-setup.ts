/**
 * F44 — Setup do smoke test do Agente de Vendas (Five Star Ricos).
 *
 * Faz a parte GHL-side (o resto — model + targeting — é via SQL):
 *   1. Upsert do contato de teste (+17867717077, "Pedro (teste IA)")
 *   2. Tag `smoke-test-ia` no contato
 *   3. Best-effort: busca telefone da location pro Pedro textar
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/smoke-fivestar-setup.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { upsertContact, addTagsToContact } from "../src/lib/ghl/operations";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const PHONE = "+17867717077";
const TAG = "smoke-test-ia";

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", LOCATION_ID)
    .maybeSingle();
  if (!loc?.company_id) throw new Error(`company_id não achado pra ${LOCATION_ID}`);

  const client = new GHLClient(loc.company_id, LOCATION_ID);

  // 1+2. Upsert contato + tag
  const up = await upsertContact(client, {
    locationId: LOCATION_ID,
    phone: PHONE,
    firstName: "Pedro",
    lastName: "(teste IA)",
    source: "smoke-test-ia",
  });
  const contactId = up.contact?.id;
  if (!contactId) throw new Error(`upsert não retornou contactId: ${JSON.stringify(up)}`);
  console.log(`✅ Contato upsertado: ${contactId} (${PHONE})`);

  await addTagsToContact(client, contactId, [TAG]);
  console.log(`✅ Tag "${TAG}" aplicada.`);

  // 3. Best-effort: telefone da location
  try {
    const locData = await client.get<{ location?: Record<string, unknown> }>(
      `/locations/${LOCATION_ID}`,
    );
    const l = locData.location || {};
    console.log(`\n📞 Location "${l.name ?? "?"}":`);
    console.log(`   phone (business): ${l.phone ?? "(não exposto)"}`);
  } catch (e) {
    console.log(`\n📞 Não consegui buscar telefone da location: ${e instanceof Error ? e.message : e}`);
  }

  console.log(`\n=== RESUMO ===`);
  console.log(`location_id: ${LOCATION_ID}`);
  console.log(`contact_id:  ${contactId}`);
  console.log(`phone:       ${PHONE}`);
  console.log(`tag:         ${TAG}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
