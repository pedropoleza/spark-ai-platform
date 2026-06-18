/**
 * F52 unit test — isAiEcho / extractAiSentTexts.
 * Hot path: falso-positivo de "humano" = agente pausa errado (fica mudo).
 * Falso-negativo = IA atropela o humano. Os dois são ruins → cobrir bem.
 */
import { isAiEcho, extractAiSentTexts, classifyLastOutbound } from "../src/lib/queue/human-takeover";

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

console.log("\n=== classifyLastOutbound (ladder unificada — isHuman) ===");
const cl = (args: Parameters<typeof classifyLastOutbound>[0]) => classifyLastOutbound(args).isHuman;

// REGRESSÃO do bug Marina 2026-06-18: o webhook usava isAiEcho CRU, sem o disc 4
// ("IA nunca falou → não é humano"). Outbound sem userId + sem aiTexts (IA ainda
// não respondeu / eco chegou antes do log) caía como humano → 35 contatos
// pausados com auto_pause:human_message e message_count=0. A ladder NÃO pausa.
eq("BUG: sem userId + IA nunca falou → NÃO humano (disc 4)",
  cl({ lastOutbound: { body: "Que bom que vc chegou até aqui! 😊", userId: "", source: "app" }, aiTexts: [] }), false);
eq("race: eco chega antes do send_message logar (aiTexts vazio) → NÃO humano",
  cl({ lastOutbound: { body: "qualquer coisa que a IA mandou", userId: "", source: "" }, aiTexts: [] }), false);

// Eco da própria IA (multi-parte) → NÃO humano (disc 2), mesmo com userId do admin.
eq("eco de parte do envio multi-parte → NÃO humano",
  cl({ lastOutbound: { body: "Oi Pedro! Pra começar, qual seu nome completo?", userId: "admin_123", source: "app" }, aiTexts: aiMsgs }), false);

// Automação do GHL (welcome) com userId → NÃO humano (disc 1, antes do userId).
eq("automação (workflow) com userId → NÃO humano",
  cl({ lastOutbound: { body: "Bem-vindo!", userId: "u1", source: "workflow" }, aiTexts: [] }), false);

// Humano de verdade assumiu DEPOIS da IA já ativa: userId + texto não-eco → humano (disc 3).
eq("humano real (userId + texto não-eco, IA já ativa) → humano",
  cl({ lastOutbound: { body: "Oi, aqui é a Márcia, vou assumir daqui", userId: "u9", source: "app" }, aiTexts: aiMsgs }), true);

// Pedro 2026-06-18 ("só pausa se o usuário enviar"): SEM userId → NÃO é humano,
// mesmo a IA já ativa e texto não-eco. Antes virava "humano" e mutava a IA por
// eco mangled (caso Marina). Bias a não-mutar.
eq("sem userId, não-eco, IA já ativa → NÃO humano (Pedro 2026-06-18)",
  cl({ lastOutbound: { body: "deixa que eu falo com ele", userId: "", source: "app" }, aiTexts: aiMsgs }), false);
// Mídia (sem texto) SEM userId → NÃO humano (sem sinal de user do GHL).
eq("mídia sem userId → NÃO humano",
  cl({ lastOutbound: { body: "", userId: "", source: "app" }, aiTexts: aiMsgs }), false);
// Mídia COM userId (rep mandou áudio/imagem manual) → humano.
eq("mídia COM userId (rep) → humano",
  cl({ lastOutbound: { body: "", userId: "u7", source: "app" }, aiTexts: aiMsgs }), true);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
