/**
 * Relatório de saúde de uma conta lead-facing.
 *   npx tsx scripts/vigia-conta.ts <locationId> [horas]
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
(async () => {
  const { vigiarConta } = await import("../src/lib/monitoring/vigia-conta");
  const loc = process.argv[2] ?? "A62s5EQj1hldOuvBEowv";
  const horas = Number(process.argv[3] ?? 24);
  const r = await vigiarConta(loc, horas);
  const icone: Record<string, string> = { critico: "🔴", alto: "🟠", medio: "🟡", ok: "🟢" };
  console.log(`\n=== SAÚDE DA CONTA ${loc} — últimas ${horas}h ===\n`);
  for (const a of r.achados) {
    console.log(`${icone[a.gravidade]} ${a.chave.padEnd(18)} ${a.resumo}`);
    if (a.detalhe) console.log(`     ${JSON.stringify(a.detalhe).slice(0, 420)}`);
  }
  const ruins = r.achados.filter((a) => a.gravidade !== "ok");
  console.log(`\n${ruins.length ? `${ruins.length} ponto(s) de atenção` : "tudo verde"}\n`);
})();
