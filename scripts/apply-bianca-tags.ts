/**
 * Bianca / Five Rings — cria as tags-alavanca da SDR, UMA vez, com a grafia
 * EXATA que o targeting espera.
 *
 * Por que pré-criar: o matching do gate é acento/caixa-insensível (deburr), mas
 * NÃO é hífen-insensível — "IA Ligada" digitada no celular NÃO casa "ia-ligada".
 * Se a SDR criar a tag na hora, o Spark Leads aceita qualquer grafia e o gatilho
 * nasce morto (é a lição da Jussara: tag duplicada = gatilho morto). Criando
 * aqui, ela só seleciona da lista.
 *
 * Tag inerte até alguém aplicar num contato — criar não muda comportamento.
 *
 *   npx tsx scripts/apply-bianca-tags.ts [--dry]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "cRavIlyC52vFYgJATgi7";
const DRY = process.argv.includes("--dry");

// Grafia canônica — tem que bater byte a byte com o targeting da Fase 0.
const TAGS = [
  { nome: "ia-ligada", uso: "SDR LIGA a IA pro contato (pelo celular)" },
  { nome: "ia-desligada", uso: "SDR DESLIGA a IA pro contato (exclusão H81)" },
];

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  if (!loc) throw new Error("location não cadastrada");
  const c = new GHLClient(loc.company_id, LOC);

  const atuais = await c.get<{ tags?: Array<{ id: string; name: string }> }>(`/locations/${LOC}/tags`);
  const existentes = (atuais.tags || []).map((t) => t.name.toLowerCase().trim());

  for (const { nome, uso } of TAGS) {
    // Procura variante suja (mesma ideia, grafia diferente) pra avisar.
    const alvo = nome.replace(/[-_\s]/g, "");
    const variantes = existentes.filter((t) => t.replace(/[-_\s]/g, "") === alvo && t !== nome);
    if (variantes.length) {
      console.log(`⚠️  "${nome}" tem variante(s) na conta: ${variantes.join(", ")} — resolver à mão antes de usar`);
    }
    if (existentes.includes(nome)) {
      console.log(`✔️  "${nome}" já existe — nada a fazer  (${uso})`);
      continue;
    }
    if (DRY) { console.log(`(dry) criaria "${nome}"  (${uso})`); continue; }
    try {
      await c.post(`/locations/${LOC}/tags`, { name: nome });
      console.log(`✅ criada: "${nome}"  (${uso})`);
    } catch (e) {
      console.log(`❌ falhou "${nome}": ${e instanceof Error ? e.message : e}`);
    }
  }

  if (!DRY) {
    // O GET logo após o POST devolve lista VELHA (consistência eventual medida
    // em 26/08: acusou ausente 1s depois de criar, presente no run seguinte).
    // Mesma espera do verify-after-write do H79.
    await new Promise((r) => setTimeout(r, 3000));
    const depois = await c.get<{ tags?: Array<{ name: string }> }>(`/locations/${LOC}/tags`);
    const nomes = (depois.tags || []).map((t) => t.name.toLowerCase().trim());
    console.log("\n=== VERIFICAÇÃO (relido da API) ===");
    for (const { nome } of TAGS) console.log(`  ${nomes.includes(nome) ? "✅" : "❌"} ${nome}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
