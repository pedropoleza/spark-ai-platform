/**
 * Vigia de contas mudas — versão de linha de comando (o cron diário roda o mesmo
 * módulo). Use quando quiser a foto AGORA sem esperar as 13h UTC.
 *
 *   npx tsx scripts/vigia-contas-mudas.ts            # só relatório, não grava sinal
 *   npx tsx scripts/vigia-contas-mudas.ts --sinais   # grava os admin_signals também
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { varrerContasMudas } from "../src/lib/monitoring/vigia-contas-mudas";

const EMITIR = process.argv.includes("--sinais");

async function main() {
  const r = await varrerContasMudas(EMITIR);
  if (!r.ok) {
    console.error("FALHOU:", r.erro);
    process.exit(1);
  }

  console.log(`\nLocations com agente lead-facing verificadas: ${r.verificadas}`);
  console.log(`Contas paradas encontradas: ${r.achados.length}${EMITIR ? ` (sinais gravados: ${r.sinais_emitidos})` : " (relatório só — use --sinais pra gravar)"}\n`);

  if (!r.achados.length) {
    console.log("✅ Nenhuma conta muda. Todas as contas com histórico seguem processando.");
    return;
  }

  const graves = r.achados.filter((a) => a.classe === "muda_com_agente_ligado");
  const escuras = r.achados.filter((a) => a.classe === "escura");

  if (graves.length) {
    console.log("🔴 AGENTE LIGADO E MUDO (o inbound não está chegando ou é barrado antes da fila):");
    for (const c of graves) {
      console.log(`   ${(c.location_name || c.location_id).slice(0, 34).padEnd(34)} ${c.location_id}`);
      console.log(`      parada há ${c.dias_parada}d · última ${String(c.ultima_atividade).slice(0, 10)} · vinha de ${c.msgs_baseline_30d} msgs/30d`);
    }
    console.log("");
  }

  if (escuras.length) {
    console.log("🟡 ESCURA (nenhum agente lead-facing ativo — desligado e não religado):");
    for (const c of escuras) {
      console.log(`   ${(c.location_name || c.location_id).slice(0, 34).padEnd(34)} ${c.location_id}`);
      console.log(`      off desde ${String(c.off_since).slice(0, 10)} · parada há ${c.dias_parada}d · histórico ${c.historico_total} msgs`);
      console.log(`      agentes: ${c.agentes.map((a) => `${a.name}[${a.status}]`).join(", ")}`);
    }
    console.log("\n   (pausa de propósito? arquive o sinal no painel — o vigia não sabe a intenção.)");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
