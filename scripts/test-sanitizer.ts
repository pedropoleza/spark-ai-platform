// Smoke test do response-sanitizer. Rodar: npx tsx scripts/test-sanitizer.ts
import { sanitizeAgentMessage, stripDashes, stripLeadingGreetings } from "../src/lib/ai/response-sanitizer";

// Casos reais de duplicação reportados pelo usuário
const greetingCases = [
  "Oi! Sou Victor, da Spark Leads 👋 Vi que você demonstrou interesse, posso te explicar rapidinho como funciona?",
  "Oi! Boa tarde 😄 Sou Victor, da equipe da Spark Leads Me conta, você tem Social Security ou Work Permit?",
  "Oi! Tudo bem por aqui também 😄 Vi que vc se cadastrou buscando mais informações sobre nossos serviços, posso te fazer algumas perguntas rápidas?",
  "Oi! Tudo bem sim 😄 Aqui é o Victor, da Spark Leads. Vi que você demonstrou interesse.",
  // Caso do vocativo
  "Boa tarde, Gabriel! Tudo bem? 😊 Me conta, você mora em qual estado?",
  "Oi Gabriel, tudo bem? Então, vamos começar",
  "Olá João! Aqui é o Victor, da Spark Leads",
  // Caso "Aqui é da equipe" (apresentação sem nome próprio)
  "Boa tarde! Tudo bem? 😊 Aqui é da equipe de atendimento. Posso te ajudar?",
];

// Conteúdo legítimo — NÃO pode ser alterado (bug anterior cortava esses)
const preserveCases = [
  "Então, me fala mais sobre seu interesse",
  "Claro! Posso te ajudar com isso",
  "Entendi. Você prefere qual horário?",
  "Ok, vamos lá",
  "Gabriel, vou te passar os detalhes",  // começa com nome mas é conteúdo, não saudação
  "Perfeito. Te envio as opções",
];

// Travessão / reticências — SEMPRE removidos
const dashCases = [
  "Oi, tudo bem? — Sou Victor e quero te ajudar",
  "Vi que você se cadastrou – posso te contar mais?",
  "Temos horários disponíveis — 10h ou 14h",
  "Olha — isso é simples, prometo",
  "Tudo certo... vamos lá... posso ajudar?",
];

let passCount = 0;
let failCount = 0;

function expect(label: string, input: string, actual: string, pred: (s: string) => boolean) {
  const ok = pred(actual);
  if (ok) passCount++;
  else failCount++;
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${label}`);
  console.log(`   IN : ${input}`);
  console.log(`   OUT: ${actual}`);
}

console.log("=== REMOÇÃO DE SAUDAÇÃO (turno > 1) ===\n");
for (const c of greetingCases) {
  const out = sanitizeAgentMessage(c, 2) as string;
  // Predicado: começou com saudação/apresentação, não pode mais começar
  const begins = out.toLowerCase().slice(0, 40);
  const badStarts = ["oi", "olá", "ola", "boa tarde", "bom dia", "boa noite",
    "tudo bem", "sou ", "aqui é", "meu nome", "e aí", "ei "];
  const bad = badStarts.some(b => begins.startsWith(b));
  expect(`Case`, c, out, () => !bad);
}

console.log("\n=== PRESERVAR CONTEÚDO LEGÍTIMO (turno > 1) ===\n");
for (const c of preserveCases) {
  const out = sanitizeAgentMessage(c, 2) as string;
  expect(`Case`, c, out, () => out === c);
}

console.log("\n=== TRAVESSÃO / RETICÊNCIAS (todo turno) ===\n");
for (const c of dashCases) {
  const out = sanitizeAgentMessage(c, 0) as string;
  expect(`Case`, c, out, () => !out.includes("—") && !out.includes("–") && !out.includes("..."));
}

console.log(`\n====== RESULTADO ======`);
console.log(`Passaram: ${passCount}`);
console.log(`Falharam: ${failCount}`);
console.log(`Total:    ${passCount + failCount}`);

// Silence unused
void stripDashes;
void stripLeadingGreetings;

process.exit(failCount > 0 ? 1 : 0);
