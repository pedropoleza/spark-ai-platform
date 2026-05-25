/**
 * Adiciona tag(s) a um contato no GHL (Spark Leads). Uso pontual/admin.
 * Uso: npx tsx -r tsconfig-paths/register scripts/add-contact-tag.ts <locationId> <contactId> <tag>
 * Ex:  ... YuR0LCZomFzrfkDK2ezo hiBobFrThXUIV58zqE86 "non whatsapp number"
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { addTagsToContact } from "../src/lib/ghl/operations";

async function main() {
  const [, , locationId, contactId, ...tagParts] = process.argv;
  const tag = tagParts.join(" ").trim();
  if (!locationId || !contactId || !tag) {
    console.error('Uso: add-contact-tag.ts <locationId> <contactId> "<tag>"');
    process.exit(1);
  }

  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", locationId)
    .maybeSingle();
  if (!loc?.company_id) {
    console.error(`company_id não encontrado pra location ${locationId}`);
    process.exit(1);
  }

  const client = new GHLClient(loc.company_id, locationId);
  await addTagsToContact(client, contactId, [tag]);
  console.log(`✅ Tag "${tag}" adicionada ao contato ${contactId} (loc ${locationId}).`);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
