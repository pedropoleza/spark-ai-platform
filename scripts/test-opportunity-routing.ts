// Golden test: roteamento semântico de oportunidades — Onda 3A (2026-05-20)
//
// Cobre P0 #3: bot usava create_opportunity pra mover stages (caso Henry).
// Agora move_opportunity existe e a família opportunity_update a aceita.
//
// Roda: npx tsx -r tsconfig-paths/register scripts/test-opportunity-routing.ts

import { analyzeCoherence, type ToolCallRecord } from "@/lib/account-assistant/core/coherence-gate";

interface Case {
  name: string;
  text: string;
  tools: ToolCallRecord[];
  expectCoherent: boolean;
  expectAction: "ok" | "rerun" | "rewrite";
  why: string;
}

const OK = { status: "ok" };

const cases: Case[] = [
  // ── CENÁRIO CORRETO: move_opportunity satisfaz "Movido pra Policy Delivery" ──
  {
    name: "Henry (correto): 'Movido pra Policy Delivery' + move_opportunity → coerente",
    text: "✅ Movido pra Policy Delivery.",
    tools: [
      { name: "list_opportunities", result: OK },
      { name: "move_opportunity", result: { status: "ok", data: { opportunity_id: "abc123", moved_to_stage: "stage_xyz" } } },
    ],
    expectCoherent: true,
    expectAction: "ok",
    why: "move_opportunity rodou com sucesso → family opportunity_update satisfeita",
  },

  // ── CENÁRIO ANTIGO (bug): create_opportunity não satisfaz 'movido' ──
  {
    name: "Henry (bug original): 'Movido pra Policy Delivery' + só create_opportunity → INCOERENTE",
    text: "✅ Movido pra Policy Delivery.",
    tools: [
      { name: "create_opportunity", result: OK },
      { name: "create_opportunity", result: OK },
    ],
    expectCoherent: false,
    expectAction: "rewrite",
    why: "create_opportunity não satisfaz family opportunity_update — o texto diz 'movido' mas só criou duplicatas. hadSuccessfulWrite=true → rewrite (não re-run, para não duplicar de novo)",
  },

  // ── update_opportunity também satisfaz 'movido' ──
  {
    name: "update_opportunity satisfaz 'movi a opp pra M3'",
    text: "Pronto, movi a opp pra M3!",
    tools: [
      { name: "update_opportunity", result: { status: "ok", data: { opportunity_id: "abc", updated: ["pipelineStageId"] } } },
    ],
    expectCoherent: true,
    expectAction: "ok",
    why: "update_opportunity está em satisfying_tools da família opportunity_update",
  },

  // ── create_opportunity legítima para criar nova opp ──
  {
    name: "Criação legítima: 'Oportunidade criada' + create_opportunity → coerente",
    text: "Oportunidade criada no pipeline 1-Prospects!",
    tools: [
      { name: "create_opportunity", result: OK },
    ],
    expectCoherent: true,
    expectAction: "ok",
    why: "create_opportunity satisfaz family opportunity_create",
  },

  // ── Nenhuma tool de opportunity → false call ──
  {
    name: "Hallucination pura: 'Movido pra Policy Delivery' sem nenhuma tool → INCOERENTE",
    text: "✅ Movido pra Policy Delivery.",
    tools: [],
    expectCoherent: false,
    expectAction: "rerun",
    why: "Sem nenhuma write bem-sucedida → re-run seguro (nada a duplicar)",
  },

  // ── update_opportunity_status satisfaz ganho/perdido ──
  {
    name: "update_opportunity_status satisfaz 'opp fechada como ganho'",
    text: "Oportunidade fechada como ganho!",
    tools: [
      { name: "update_opportunity_status", result: { status: "ok", data: { opportunity_id: "abc", status: "won" } } },
    ],
    expectCoherent: true,
    expectAction: "ok",
    why: "update_opportunity_status está em satisfying_tools da família opportunity_update",
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result = analyzeCoherence(c.text, c.tools);
  const okCoherent = result.coherent === c.expectCoherent;
  const okAction = result.action === c.expectAction;
  const pass = okCoherent && okAction;

  if (pass) {
    console.log(`  ✓  ${c.name}`);
    passed++;
  } else {
    console.log(`  ✗  ${c.name}`);
    if (!okCoherent) {
      console.log(`       coherent: esperado ${c.expectCoherent}, obtido ${result.coherent}`);
    }
    if (!okAction) {
      console.log(`       action:   esperado ${c.expectAction}, obtido ${result.action}`);
    }
    console.log(`       why: ${c.why}`);
    if (result.violations.length > 0) {
      console.log(`       violations: ${result.violations.map((v) => `${v.family}/"${v.matched_text}"`).join(", ")}`);
    }
    failed++;
  }
}

console.log(`\n${passed}/${passed + failed} casos passaram`);
if (failed > 0) {
  process.exit(1);
}
