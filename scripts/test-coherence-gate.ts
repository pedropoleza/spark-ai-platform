// Golden test do coherence gate (Onda 1, refatoração V2).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-coherence-gate.ts
//
// Cobre as falhas REAIS do review + a regra de ouro de segurança:
// NUNCA re-executar quando já houve escrita bem-sucedida (não duplica ação de cliente).

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
const ERR = { status: "error", message: "GHL rejeitou" };
const NOTFOUND = { status: "not_found", message: "Contato sem notas ainda." };

const cases: Case[] = [
  // ── FALSE CALLS reais (tools vazias) → rerun seguro ──
  {
    name: "Gustavo: 'Nota salva' com tools=[]",
    text: "Nota salva pra Caroline Estercio!",
    tools: [],
    expectCoherent: false, expectAction: "rerun",
    why: "Afirmou nota sem create_note e sem nenhuma escrita → re-run seguro",
  },
  {
    name: "Gustavo msg114: 'Notas criadas' mas só leu (not_found)",
    text: "Pronto, agora sim! Notas criadas nas três.",
    tools: [
      { name: "search_contacts", result: OK },
      { name: "get_contact_notes", result: NOTFOUND },
    ],
    expectCoherent: false, expectAction: "rerun",
    why: "Só rodou read (search/get); create_note nunca rodou → re-run seguro",
  },
  {
    name: "Reminder fantasma (signal fd28abb1)",
    text: "Ótimo! Lembrete agendado pra amanhã às 9:00 AM ✅",
    tools: [],
    expectCoherent: false, expectAction: "rerun",
    why: "schedule_reminder não rodou",
  },
  {
    name: "create_note FALHOU mas bot disse salvou",
    text: "Prontinho, salvei a nota no contato.",
    tools: [{ name: "create_note", result: ERR }],
    expectCoherent: false, expectAction: "rerun",
    why: "create_note rodou mas com status error → não satisfaz; nenhuma write ok → re-run",
  },

  // ── Caso HENRY: claim de MOVER com create_opportunity (REGRA DE OURO) ──
  {
    name: "Henry: 'Movido pra Policy Delivery' com create_opportunity",
    text: "✅ Movido pra Policy Delivery!",
    tools: [
      { name: "create_opportunity", result: OK },
      { name: "create_opportunity", result: OK },
    ],
    expectCoherent: false, expectAction: "rewrite",
    why: "claim de MOVER não é satisfeita por create; create rodou ok → NÃO re-run (não duplicar), reescrever",
  },

  // ── REGRA DE OURO: escrita bem-sucedida + claim extra falsa → rewrite (nunca rerun) ──
  {
    name: "Enviou 4 msgs reais + disse 'e salvei a nota' (nota não salva)",
    text: "Enviei as 4 mensagens e salvei a nota no contato.",
    tools: [
      { name: "send_message_to_contact", result: OK },
      { name: "send_message_to_contact", result: OK },
      { name: "send_message_to_contact", result: OK },
      { name: "send_message_to_contact", result: OK },
    ],
    expectCoherent: false, expectAction: "rewrite",
    why: "message satisfeita; note não — mas houve escrita ok (4 envios) → JAMAIS re-executar (duplicaria envios)",
  },

  // ── COERENTES (não deve disparar) ──
  {
    name: "Nota salva COM create_note ok",
    text: "Pronto, nota salva no contato!",
    tools: [{ name: "create_note", result: OK }],
    expectCoherent: true, expectAction: "ok",
    why: "create_note rodou com sucesso",
  },
  {
    name: "Opp movida COM update_opportunity_status ok",
    text: "Movido pra Policy Delivery!",
    tools: [{ name: "update_opportunity_status", result: OK }],
    expectCoherent: true, expectAction: "ok",
    why: "update_opportunity_status satisfaz claim de mover",
  },
  {
    name: "Opp criada COM create_opportunity ok",
    text: "Oportunidade criada pro João!",
    tools: [{ name: "create_opportunity", result: OK }],
    expectCoherent: true, expectAction: "ok",
    why: "create satisfaz claim de criação",
  },
  {
    name: "Enviou 4 msgs e só afirmou envio",
    text: "Pronto! Enviei as 4 mensagens.",
    tools: [
      { name: "send_message_to_contact", result: OK },
      { name: "send_message_to_contact", result: OK },
      { name: "send_message_to_contact", result: OK },
      { name: "send_message_to_contact", result: OK },
    ],
    expectCoherent: true, expectAction: "ok",
    why: "todas as msgs enviadas com sucesso",
  },

  // ── FALSOS-POSITIVOS (negação/preview/citação) → coerente ──
  {
    name: "FP: 'Henry não tem oportunidade criada ainda'",
    text: "O Henry não tem oportunidade criada ainda no pipeline 1-Prospects.",
    tools: [],
    expectCoherent: true, expectAction: "ok",
    why: "negação 'não tem'",
  },
  {
    name: "FP: 'não criei nenhum lembrete'",
    text: "Não automaticamente — eu não criei nenhum lembrete recorrente ainda.",
    tools: [],
    expectCoherent: true, expectAction: "ok",
    why: "negação 'não criei'",
  },
  {
    name: "FP: preview de template entre aspas",
    text: 'Mensagem que vai ser enviada: "Olá, agendamos pra terça a reunião"',
    tools: [],
    expectCoherent: true, expectAction: "ok",
    why: "preview de template",
  },
  {
    name: "FP: sumário de nota do cliente (segunda reunião marcada)",
    text: "*Telma Camargo*\nAtendimento em andamento — segunda reunião marcada para quarta.",
    tools: [],
    expectCoherent: true, expectAction: "ok",
    why: "sumário de nota citando info do cliente",
  },
];

let pass = 0;
let fail = 0;
console.log("=== Golden test: coherence-gate (Onda 1) ===\n");
for (const c of cases) {
  const r = analyzeCoherence(c.text, c.tools);
  const okCoherent = r.coherent === c.expectCoherent;
  const okAction = r.action === c.expectAction;
  const ok = okCoherent && okAction;
  console.log(`${ok ? "✅" : "❌"} ${c.name}`);
  console.log(`   coerente=${r.coherent} (exp ${c.expectCoherent}) · action=${r.action} (exp ${c.expectAction}) · hadWrite=${r.hadSuccessfulWrite}`);
  if (!ok) {
    console.log(`   WHY: ${c.why}`);
    console.log(`   violations=${JSON.stringify(r.violations)}`);
    fail++;
  } else {
    pass++;
  }
}
console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
