/**
 * F52 unit test — isAiEcho / extractAiSentTexts.
 * Hot path: falso-positivo de "humano" = agente pausa errado (fica mudo).
 * Falso-negativo = IA atropela o humano. Os dois são ruins → cobrir bem.
 */
import { isAiEcho, extractAiSentTexts } from "../src/lib/queue/human-takeover";

let passed = 0, failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name} (esperava ${expected}, veio ${actual})`); failed++; }
}

const aiMsgs = [
  "Oi Pedro! Pra começar, qual seu nome completo?",
  "Perfeito. Tenho disponibilidade hoje às 11:30 AM ou 4:00 PM (ET), qual fica melhor?",
];

console.log("\n=== isAiEcho (true = é eco da IA / NÃO é humano) ===");
// Echo da IA → true
eq("echo exato", isAiEcho("Oi Pedro! Pra começar, qual seu nome completo?", aiMsgs), true);
eq("echo com sufixo do canal", isAiEcho("Oi Pedro! Pra começar, qual seu nome completo? 🙂", aiMsgs), true);
eq("echo truncado", isAiEcho("Perfeito. Tenho disponibilidade hoje às 11:30 AM ou 4:00 PM", aiMsgs), true);
// HUMANO (não bate com a IA) → false
eq("texto humano", isAiEcho("Oi, aqui é a Márcia, vou assumir daqui", aiMsgs), false);
eq("humano curto", isAiEcho("deixa comigo", aiMsgs), false);
// Curto: <20 exige match exato
eq("curto exato", isAiEcho("ok", ["ok"]), true);
eq("curto diferente", isAiEcho("ok", ["blz"]), false);
// Edge — não trava
eq("body vazio", isAiEcho("", aiMsgs), false);
eq("sem mensagens da IA", isAiEcho("qualquer", []), false);

console.log("\n=== extractAiSentTexts ===");
eq("payload string", JSON.stringify(extractAiSentTexts([{ action_payload: { message: "oi" } }])), '["oi"]');
eq("payload array", JSON.stringify(extractAiSentTexts([{ action_payload: { message: ["a", "b"] } }])), '["a","b"]');
eq("payload null-safe", extractAiSentTexts([{ action_payload: null }, { action_payload: {} }]).length, 0);
eq("null rows", extractAiSentTexts(null).length, 0);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
