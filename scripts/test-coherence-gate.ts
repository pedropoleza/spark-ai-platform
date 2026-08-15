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

  // ── H78 (caso Bianca/Precious Planning, ticket #95, 05/08): "Stop" → "parei" sem tool ──
  {
    name: "Bianca: 'Tudo certo, parei' com tools=[]",
    text: "Tudo certo, parei. Qualquer coisa é só chamar!",
    tools: [],
    expectCoherent: false, expectAction: "rerun",
    why: "alegou ter parado os avisos sem set_proactivity nem nenhuma escrita — a frase EXATA do flagrante de prod",
  },
  {
    name: "'parei' com set_proactivity ok → coerente",
    text: "Tudo certo, parei os avisos pós-reunião. Qualquer coisa é só chamar!",
    tools: [{ name: "set_proactivity", result: OK }],
    expectCoherent: true, expectAction: "ok",
    why: "a escrita rodou de verdade — genérico satisfeito",
  },
  {
    name: "'Desativei os lembretes' com tools=[]",
    text: "Desativei os lembretes de task pra você.",
    tools: [],
    expectCoherent: false, expectAction: "rerun",
    why: "desativei sem escrita nenhuma",
  },
  {
    name: "'pausei a campanha' com pause_bulk_job ok → coerente (regressão)",
    text: "Pausei a campanha, ninguém mais recebe até você mandar retomar.",
    tools: [{ name: "pause_bulk_job", result: OK }],
    expectCoherent: true, expectAction: "ok",
    why: "pausei já era coberto e segue satisfeito por qualquer write ok",
  },
  {
    name: "'Não vou mais te mandar os avisos' com tools=[] (família proactivity_off)",
    text: "Entendido! Não vou mais te mandar os avisos de task.",
    tools: [],
    expectCoherent: false, expectAction: "rerun",
    why: "promessa em futuro de desligar — o catch-all de pretérito não pega; a família nova pega",
  },
  {
    name: "'Não vou mais te lembrar' com set_proactivity ok → coerente",
    text: "Fechado, não vou mais te lembrar das tasks. Se mudar de ideia é só falar.",
    tools: [{ name: "set_proactivity", result: OK }],
    expectCoherent: true, expectAction: "ok",
    why: "promessa lastreada na tool da família",
  },
  {
    name: "FP: 'não vou mandar agora, quer que eu mande?' (pergunta, não claim)",
    text: "Ainda não vou mandar nada — quer que eu envie a mensagem pro João agora?",
    tools: [],
    expectCoherent: true, expectAction: "ok",
    why: "'não vou mandar' sem 'mais' não é promessa de desligar; e é pergunta",
  },
];

// ── Família pipeline_add (flag COHERENCE_PIPELINE_FAMILY, loop de qualidade 2026-07-06) ──
// Rodam com a flag LIGADA. Provam: casa a falsa confirmação de "adicionada ao funil"
// (caso Leidy) e NÃO casa as confirmações reais nem os proativos "movimentar o pipeline".
const pipelineCases: Case[] = [
  {
    name: "Leidy: 'adicionada ao funil X, stage Y' com tools=[] (BUG real 2026-07-03)",
    text: "Feito! ✅ *Leidy Eder 3T* adicionada ao funil *1- Prospects*, stage *New Leads*.",
    tools: [],
    expectCoherent: false, expectAction: "rerun",
    why: "afirmou add no funil sem create/move_opportunity → falsa confirmação, re-run seguro",
  },
  {
    name: "TP real: 'adicionado ao funil' COM create_opportunity → satisfeito",
    text: "*Murilo Santos* adicionado ao funil *4- Agency*, stage *Proposed Agent*. ✅",
    tools: [
      { name: "list_pipelines", result: OK },
      { name: "create_opportunity", result: OK },
    ],
    expectCoherent: true, expectAction: "ok",
    why: "create_opportunity rodou com sucesso → confirmação legítima",
  },
  {
    name: "FP: proativo 'bom dia pra movimentar o pipeline' (infinitivo) não casa",
    text: "☀️ Bom dia, *Marcos*! Terça-feira chegou — bom dia pra movimentar o pipeline.",
    tools: [],
    expectCoherent: true, expectAction: "ok",
    why: "'movimentar' é infinitivo descritivo, não afirmação de escrita",
  },
  {
    name: "FP: 'não adicionei ela ao funil ainda' (negação)",
    text: "Não adicionei ela ao funil ainda — quer que eu adicione?",
    tools: [],
    expectCoherent: true, expectAction: "ok",
    why: "negação antes do match",
  },
];

let pass = 0;
let fail = 0;
console.log("=== Golden test: coherence-gate (Onda 1) ===\n");
function runCase(c: Case): boolean {
  const r = analyzeCoherence(c.text, c.tools);
  const ok = r.coherent === c.expectCoherent && r.action === c.expectAction;
  console.log(`${ok ? "✅" : "❌"} ${c.name}`);
  console.log(`   coerente=${r.coherent} (exp ${c.expectCoherent}) · action=${r.action} (exp ${c.expectAction}) · hadWrite=${r.hadSuccessfulWrite}`);
  if (!ok) {
    console.log(`   WHY: ${c.why}`);
    console.log(`   violations=${JSON.stringify(r.violations)}`);
  }
  return ok;
}

for (const c of cases) {
  if (runCase(c)) pass++;
  else fail++;
}

// Família nova só ativa com a flag — prova que LIGADA pega o BUG e não gera FP.
console.log("\n--- pipeline_add (COHERENCE_PIPELINE_FAMILY=1) ---");
process.env.COHERENCE_PIPELINE_FAMILY = "1";
for (const c of pipelineCases) {
  if (runCase(c)) pass++;
  else fail++;
}
// Prova de paridade: com a flag DESLIGADA o caso Leidy passa batido (comportamento de hoje).
console.log("\n--- paridade: flag OFF não muda nada (Leidy passa batido) ---");
delete process.env.COHERENCE_PIPELINE_FAMILY;
{
  const off = analyzeCoherence(pipelineCases[0].text, pipelineCases[0].tools);
  const ok = off.coherent === true && off.action === "ok";
  console.log(`${ok ? "✅" : "❌"} Leidy com flag OFF → coerente=${off.coherent} action=${off.action} (esperado ok/true = idêntico a hoje)`);
  if (ok) pass++;
  else fail++;
}

console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
