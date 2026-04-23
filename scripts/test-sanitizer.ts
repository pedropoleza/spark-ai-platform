// Smoke test do response-sanitizer. Rodar: npx tsx scripts/test-sanitizer.ts
import { sanitizeAgentMessage, stripDashes, stripLeadingGreetings } from "../src/lib/ai/response-sanitizer";

// Casos reais reportados pelo usuário
const greetingCases = [
  "Oi! Sou Victor, da Spark Leads 👋 Vi que você demonstrou interesse, posso te explicar rapidinho como funciona?",
  "Oi! Boa tarde 😄 Sou Victor, da equipe da Spark Leads Me conta, você tem Social Security ou Work Permit?",
  "Oi! Tudo bem por aqui também 😄 Vi que vc se cadastrou buscando mais informações sobre nossos serviços, posso te fazer algumas perguntas rápidas?",
  "Oi! Tudo bem sim 😄 Aqui é o Victor, da Spark Leads. Vi que você demonstrou interesse.",
];

// Casos onde NÃO deve strippar nada (conteúdo legítimo começando com capitalizado)
const preserveCases = [
  "Então, me fala mais sobre seu interesse",
  "Claro! Posso te ajudar com isso",
  "Entendi. Você prefere qual horário?",
  "Ok, vamos lá",
];

// Casos de travessão (SEMPRE tira, mesmo no turno 1)
const dashCases = [
  "Oi, tudo bem? — Sou Victor e quero te ajudar",
  "Vi que você se cadastrou – posso te contar mais?",
  "Temos horários disponíveis — 10h ou 14h",
  "Olha — isso é simples, prometo",
];

console.log("=== REMOÇÃO DE SAUDAÇÃO (turno > 1) ===");
for (const c of greetingCases) {
  const out = sanitizeAgentMessage(c, 2);
  console.log(`IN : ${c}`);
  console.log(`OUT: ${out}\n`);
}

console.log("\n=== PRESERVAR CONTEÚDO LEGÍTIMO (turno > 1) ===");
for (const c of preserveCases) {
  const out = sanitizeAgentMessage(c, 2);
  const ok = out === c ? "✓" : "✗ ALTEROU!";
  console.log(`${ok} IN: ${c}`);
  if (out !== c) console.log(`   OUT: ${out}`);
}

console.log("\n=== REMOÇÃO DE TRAVESSÃO (sempre, todo turno) ===");
for (const c of dashCases) {
  const turn1 = sanitizeAgentMessage(c, 0);
  const turn2 = sanitizeAgentMessage(c, 2);
  console.log(`IN    : ${c}`);
  console.log(`TURN 1: ${turn1}`);
  console.log(`TURN 2: ${turn2}\n`);
}

console.log("\n=== stripDashes isolado ===");
for (const c of dashCases) {
  console.log(`IN : ${c}`);
  console.log(`OUT: ${stripDashes(c)}\n`);
}

// Silence unused import warning
void stripLeadingGreetings;
