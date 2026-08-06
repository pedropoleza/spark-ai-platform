/**
 * Read-only: tags + atividade recente de contatos da Richify.us
 * (location VKJITQwWwWVRzce0dbSb) pra decidir o TARGETING dos agentes.
 *   npx tsx scripts/probe-richify-tags.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";
const LOCATION = "VKJITQwWwWVRzce0dbSb";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);

  // Tags cadastradas na location (catálogo, independente de uso)
  console.log("=== TAGS CADASTRADAS NA LOCATION ===");
  try {
    const r = await client.get<any>(`/locations/${LOCATION}/tags`);
    const tags = r.tags || [];
    console.log(`  ${tags.length} tag(s):`);
    for (const t of tags) console.log(`   - "${t.name}" (${t.id})`);
  } catch (e) {
    console.log(`  ERRO tags: ${e instanceof Error ? e.message : e}`);
  }

  // Amostra de contatos com detalhe (tags + source + criação)
  console.log("\n=== CONTATOS (amostra 20, mais recentes) ===");
  try {
    const r = await client.post<any>(`/contacts/search`, {
      locationId: LOCATION,
      pageLimit: 20,
      sort: [{ field: "dateAdded", direction: "desc" }],
    });
    const contacts = r.contacts || [];
    console.log(`  total=${r.total ?? "?"} | amostra=${contacts.length}`);
    const tagCount = new Map<string, number>();
    const srcCount = new Map<string, number>();
    for (const c of contacts) {
      for (const t of c.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
      const s = c.source || c.attributionSource?.utmSource || "(sem source)";
      srcCount.set(s, (srcCount.get(s) || 0) + 1);
    }
    console.log("  --- tags na amostra ---");
    for (const [t, n] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${n}x  ${t}`);
    if (!tagCount.size) console.log("   (nenhuma tag)");
    console.log("  --- sources na amostra ---");
    for (const [s, n] of [...srcCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${n}x  ${s}`);
    console.log("  --- 5 mais recentes ---");
    for (const c of contacts.slice(0, 5))
      console.log(
        `   ${c.dateAdded} | ${c.firstName || ""} ${c.lastName || ""} | ${c.phone || "-"} | tags=${JSON.stringify(c.tags || [])} | src=${c.source || "-"}`
      );
  } catch (e) {
    console.log(`  ERRO contacts/search: ${e instanceof Error ? e.message : e}`);
  }

  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
