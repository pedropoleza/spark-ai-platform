/**
 * H39 (Pedro 2026-06-10) — helper de concorrência do polling post_meeting do
 * cron proativo. Pura lógica, sem DB/rede.
 *
 * Cobre o que o cron depende de mapWithConcurrency (o fan-out de calls GHL
 * por rep×location):
 *   1. preserva ordem (results[i] ↔ items[i]);
 *   2. respeita o cap (nunca mais que `limit` fn em voo) — evita thundering-herd
 *      no mutex de token do GHL;
 *   3. isola falha parcial QUANDO o fn se auto-protege (padrão do post_meeting:
 *      fn faz try/catch e devolve {ok:false}) — uma location que cai não
 *      derruba as outras;
 *   4. processa todos os items, sem buraco.
 *
 * Rodar: `npx tsx scripts/test-cron-reactive-throttle.ts`
 */
import { mapWithConcurrency } from "../src/lib/utils/concurrency";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  ❌ ${msg}`);
    failures++;
  } else {
    console.log(`  ✅ ${msg}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testOrder() {
  console.log("teste 1: preserva ordem");
  const items = [10, 20, 30, 40, 50];
  // Tempos invertidos: o último item resolve primeiro, mas o resultado tem que
  // voltar na ordem original dos items.
  const out = await mapWithConcurrency(items, 3, async (n, i) => {
    await sleep((items.length - i) * 5);
    return n * 2;
  });
  assert(
    JSON.stringify(out) === JSON.stringify([20, 40, 60, 80, 100]),
    "resultados na ordem dos items (não na ordem de resolução)",
  );
}

async function testConcurrencyCap() {
  console.log("teste 2: respeita o cap");
  const cap = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, cap, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(5);
    inFlight--;
    return n;
  });
  assert(maxInFlight <= cap, `nunca passou de ${cap} em voo (pico real: ${maxInFlight})`);
  assert(maxInFlight === cap, `saturou o pool ao menos uma vez (pico: ${maxInFlight})`);
}

async function testPartialFailureIsolation() {
  console.log("teste 3: falha parcial isolada (fn auto-protegido)");
  const items = [1, 2, 3, 4, 5];
  // Espelha o uso real: o fn faz try/catch e devolve discriminado, então o pool
  // nunca rejeita e os itens bons passam.
  const out = await mapWithConcurrency(items, 2, async (n) => {
    try {
      if (n === 3) throw new Error("location 3 caiu");
      return { ok: true as const, n };
    } catch (e) {
      return { ok: false as const, n, error: (e as Error).message };
    }
  });
  const ok = out.filter((r) => r.ok);
  const bad = out.filter((r) => !r.ok);
  assert(ok.length === 4, "4 itens ok mesmo com 1 falhando");
  assert(bad.length === 1 && bad[0].n === 3, "o item 3 veio marcado como falho");
}

async function testProcessesAll() {
  console.log("teste 4: processa todos os items");
  const items = Array.from({ length: 37 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 8, async (n) => n);
  assert(out.length === 37, "37 entradas → 37 resultados");
  assert(out.every((v, i) => v === i), "todos processados, sem buraco");
}

async function main() {
  await testOrder();
  await testConcurrencyCap();
  await testPartialFailureIsolation();
  await testProcessesAll();
  console.log("");
  if (failures > 0) {
    console.error(`❌ ${failures} assert(s) falharam`);
    process.exit(1);
  }
  console.log("✅ todos os testes passaram");
}

main();
