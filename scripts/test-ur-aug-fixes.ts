/**
 * Testes dos fixes do ultra-review 2026-08-03 (H64) — partes puras.
 *
 * 1. matchPipelineStage: resolução de funil/etapa por id OU nome (os casos
 *    reais: automação salva com NOME → falha silenciosa; LLM passa nome).
 * 2. Callback de entrega: lógica de desconto de silêncio (espelhada aqui como
 *    verificação da regra — decremento com piso 0 e despausa < 3).
 *
 * Rodar: npx tsx scripts/test-ur-aug-fixes.ts
 */
import { matchPipelineStage } from "../src/lib/ghl/operations";

let pass = 0,
  fail = 0;
function check(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

const PIPES = [
  {
    id: "pIdAAAAAAAAAAAAAAA01",
    name: "Funil de Vendas",
    stages: [
      { id: "stIdAAAAAAAAAAAAAA01", name: "Novo Lead" },
      { id: "stIdAAAAAAAAAAAAAA02", name: "Qualificado" },
    ],
  },
  {
    id: "pIdBBBBBBBBBBBBBBB02",
    name: "Recrutamento",
    stages: [{ id: "stIdBBBBBBBBBBBBBB01", name: "Entrevista Marcada" }],
  },
];

console.log("\n1. matchPipelineStage — id ou nome");
check(
  "id exato + id exato",
  JSON.stringify(matchPipelineStage(PIPES, "pIdAAAAAAAAAAAAAAA01", "stIdAAAAAAAAAAAAAA02")) ===
    JSON.stringify({ pipelineId: "pIdAAAAAAAAAAAAAAA01", stageId: "stIdAAAAAAAAAAAAAA02" }),
);
check(
  "NOME do funil + NOME da etapa (caso das automações Maria/Gian)",
  JSON.stringify(matchPipelineStage(PIPES, "Funil de Vendas", "Qualificado")) ===
    JSON.stringify({ pipelineId: "pIdAAAAAAAAAAAAAAA01", stageId: "stIdAAAAAAAAAAAAAA02" }),
);
check(
  "nome case-insensitive + espaços",
  JSON.stringify(matchPipelineStage(PIPES, "  funil de vendas ", " novo lead ")) ===
    JSON.stringify({ pipelineId: "pIdAAAAAAAAAAAAAAA01", stageId: "stIdAAAAAAAAAAAAAA01" }),
);
check(
  "id do funil + nome da etapa (misto)",
  matchPipelineStage(PIPES, "pIdBBBBBBBBBBBBBBB02", "entrevista marcada")?.stageId === "stIdBBBBBBBBBBBBBB01",
);
check("funil inexistente → null", matchPipelineStage(PIPES, "Funil Fantasma", "Novo Lead") === null);
check("etapa de OUTRO funil → null (não vaza cross-pipeline)", matchPipelineStage(PIPES, "Recrutamento", "Qualificado") === null);
check("lista vazia → null", matchPipelineStage([], "x", "y") === null);

// ---------------------------------------------------------------------------
console.log("\n2. Regra do desconto de silêncio (invariantes)");
// A regra implementada no callback: counter>0 → counter-1; se novo<3 e pausado,
// despausa. Espelho puro pra travar a semântica.
function descontoSilencio(cur: number | undefined, pausado: boolean): { novo?: number; despausa: boolean } {
  if (typeof cur !== "number" || cur <= 0) return { despausa: false };
  const novo = cur - 1;
  return { novo, despausa: pausado && novo < 3 };
}
check("counter 3 pausado → 2 e DESPAUSA (caso Daniely)", JSON.stringify(descontoSilencio(3, true)) === JSON.stringify({ novo: 2, despausa: true }));
check("counter 1 não-pausado → 0 sem mexer em pausa", JSON.stringify(descontoSilencio(1, false)) === JSON.stringify({ novo: 0, despausa: false }));
check("counter 0 → intocado (sem negativo)", JSON.stringify(descontoSilencio(0, true)) === JSON.stringify({ despausa: false }));
check("counter undefined → intocado", JSON.stringify(descontoSilencio(undefined, true)) === JSON.stringify({ despausa: false }));
check("counter 4 pausado → 3, NÃO despausa (silêncio real preservado)", JSON.stringify(descontoSilencio(4, true)) === JSON.stringify({ novo: 3, despausa: false }));

console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : ""}\n`);
process.exit(fail ? 1 : 0);
