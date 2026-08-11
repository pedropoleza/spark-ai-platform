/**
 * Read-only: valida a ativação por ORIGEM contra contatos REAIS da
 * Marina's Support Account (A62s5EQj1hldOuvBEowv), passando pelo caminho
 * COMPLETO de produção (`checkContactMatchesTargeting`, que busca o contato no
 * Spark Leads igual o runtime faz).
 *
 * Serve pra responder "quantos leads essa regra pegaria?" antes de ligar.
 *
 *   npx tsx -r tsconfig-paths/register scripts/probe-targeting-anuncio-marina.ts [locationId]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";
import { checkContactMatchesTargeting } from "@/lib/queue/targeting";
import type { TargetingRule } from "@/types/agent";

const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";
const LOCATION = process.argv[2] || "A62s5EQj1hldOuvBEowv";
const AMOSTRA = 40;

const REGRA_ANUNCIO: TargetingRule[] = [
  {
    id: "veio-de-anuncio",
    type: "attribution",
    attribution_field: "sessionSource",
    attribution_operator: "contains",
    attribution_value: "Paid",
  },
];

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  const loc = await client.get<Record<string, unknown>>(`/locations/${LOCATION}`);
  const nome = ((loc.location || loc) as { name?: string }).name || LOCATION;
  console.log(`Conta: ${nome}\nRegra: origem "Como chegou" CONTÉM "Paid" (1º contato)\n`);

  const r = await client.post<{ contacts?: Record<string, unknown>[] }>(`/contacts/search`, {
    locationId: LOCATION,
    pageLimit: AMOSTRA,
    sort: [{ field: "dateAdded", direction: "desc" }],
  });
  const contatos = r.contacts || [];

  let atende = 0;
  let ignora = 0;
  const divergencias: string[] = [];

  for (const c of contatos) {
    const id = String(c.id);
    const attr = (c.attributionSource || {}) as Record<string, unknown>;
    const sessao = String(attr.sessionSource || "—");
    // caminho REAL de produção (faz o GET no Spark Leads por dentro)
    const res = await checkContactMatchesTargeting(id, REGRA_ANUNCIO, COMPANY, LOCATION, {
      failMode: "closed",
    });
    const esperado = /paid/i.test(sessao);
    if (res.ok) atende++;
    else ignora++;
    if (res.ok !== esperado) {
      divergencias.push(`${id} | sessionSource="${sessao}" | motor=${res.ok ? "ATENDE" : "ignora"} | esperado=${esperado ? "ATENDE" : "ignora"}`);
    }
    const nomeC = `${c.firstName || ""} ${c.lastName || ""}`.trim().slice(0, 26);
    console.log(`  ${res.ok ? "✅ ATENDE" : "   ignora"} | ${sessao.padEnd(14)} | ${nomeC}`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`amostra: ${contatos.length} contatos`);
  console.log(`  a IA atenderia: ${atende}`);
  console.log(`  ficaria de fora: ${ignora}`);
  console.log(
    `\ndivergências entre o motor e o campo cru: ${divergencias.length}${divergencias.length ? "" : " ✅"}`,
  );
  for (const d of divergencias) console.log(`  ⚠️ ${d}`);
  process.exit(divergencias.length === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
