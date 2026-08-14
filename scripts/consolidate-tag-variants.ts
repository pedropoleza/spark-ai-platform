/**
 * Consolida grafias irmãs de uma tag numa location (H75, 2026-08-12).
 *
 * Nasceu do caso Jussara: a conta tinha "no show" e "no-show" pro mesmo
 * conceito, o workflow escutava só a segunda, e quem levou a primeira nunca
 * entrou na sequência. O resolver (lib/ghl/tag-resolver.ts) impede novas
 * órfãs; este script limpa as que já existem.
 *
 * ⚠️ Adicionar a tag canônica DISPARA as automações amarradas nela. Em contato
 * antigo isso vira mensagem retroativa pro lead do cliente — por isso o default
 * é dry-run e existe --somente-remover pra limpar sem disparar nada.
 *
 *   npx tsx scripts/consolidate-tag-variants.ts <locationId> "<tag canônica>"
 *   npx tsx scripts/consolidate-tag-variants.ts <locationId> "no-show" --apply
 *   npx tsx scripts/consolidate-tag-variants.ts <locationId> "no-show" --apply --somente-remover
 *   npx tsx scripts/consolidate-tag-variants.ts <locationId> "no-show" --apply --contato <contactId>
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const [, , LOCATION_ID, TAG_CANONICA] = process.argv;
const APPLY = process.argv.includes("--apply");
const SOMENTE_REMOVER = process.argv.includes("--somente-remover");
/**
 * Restringe a UM contato. Existe porque mover a tag dispara a automação da
 * conta: em contato antigo isso vira mensagem retroativa pro lead, então às
 * vezes a decisão é caso a caso, não em lote.
 */
const SO_CONTATO = (() => {
  const i = process.argv.indexOf("--contato");
  return i >= 0 ? process.argv[i + 1] : null;
})();

async function main() {
  if (!LOCATION_ID || !TAG_CANONICA) {
    console.error('uso: npx tsx scripts/consolidate-tag-variants.ts <locationId> "<tag>" [--apply] [--somente-remover]');
    process.exit(1);
  }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { GHLClient } = await import("../src/lib/ghl/client");
  const { tagKey } = await import("../src/lib/ghl/tag-resolver");

  const sb = createAdminClient();
  const { data: loc } = await sb
    .from("locations")
    .select("company_id")
    .eq("location_id", LOCATION_ID)
    .maybeSingle();
  if (!loc?.company_id) throw new Error(`location ${LOCATION_ID} não está em 'locations'`);

  const client = new GHLClient(loc.company_id, LOCATION_ID);

  const cat = await client.get<{ tags?: Array<{ name: string }> }>(`/locations/${LOCATION_ID}/tags`);
  const todas = (cat.tags || []).map((t) => t.name).filter(Boolean);
  const alvo = tagKey(TAG_CANONICA);
  const irmas = todas.filter((n) => tagKey(n) === alvo);

  console.log(`\nlocation ${LOCATION_ID}`);
  console.log(`chave "${alvo}" → ${irmas.length} grafia(s): ${JSON.stringify(irmas)}`);
  if (!irmas.includes(TAG_CANONICA)) {
    console.error(`\n❌ "${TAG_CANONICA}" não existe na conta. Grafias disponíveis: ${JSON.stringify(irmas)}`);
    process.exit(1);
  }

  const variantes = irmas.filter((n) => n !== TAG_CANONICA);
  if (!variantes.length) {
    console.log("\n✅ nada a consolidar — só existe a grafia canônica.");
    return;
  }

  let movidos = 0;
  for (const variante of variantes) {
    const res = await client.post<{ contacts?: Array<{ id: string; contactName?: string; tags?: string[] }> }>(
      "/contacts/search",
      {
        locationId: LOCATION_ID,
        pageLimit: 100,
        filters: [{ field: "tags", operator: "eq", value: variante }],
      },
    );
    const todosDaVariante = res.contacts || [];
    const contatos = SO_CONTATO
      ? todosDaVariante.filter((c) => c.id === SO_CONTATO)
      : todosDaVariante;
    console.log(
      `\n── "${variante}" → "${TAG_CANONICA}" (${contatos.length} contato(s)` +
        (SO_CONTATO ? ` — filtrado de ${todosDaVariante.length} por --contato` : "") +
        ")",
    );

    for (const c of contatos) {
      const jaTem = (c.tags || []).includes(TAG_CANONICA);
      const acao = SOMENTE_REMOVER || jaTem ? "só remove a variante" : "adiciona canônica + remove variante";
      console.log(`   ${(c.contactName || c.id).padEnd(30)} ${acao}`);
      if (!APPLY) continue;

      if (!SOMENTE_REMOVER && !jaTem) {
        await client.post(`/contacts/${c.id}/tags`, { tags: [TAG_CANONICA] });
      }
      await client.delete(`/contacts/${c.id}/tags`, { tags: [variante] });
      movidos++;
    }
  }

  console.log(
    APPLY
      ? `\n✅ ${movidos} contato(s) atualizados.`
      : `\n(dry-run — nada foi escrito. Rode com --apply pra valer.)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
