/**
 * F52 unit test — isAiEcho / extractAiSentTexts.
 * Hot path: falso-positivo de "humano" = agente pausa errado (fica mudo).
 * Falso-negativo = IA atropela o humano. Os dois são ruins → cobrir bem.
 */
import { isAiEcho, extractAiSentTexts, classifyLastOutbound, hasUnfilledMergeField } from "../src/lib/queue/human-takeover";
import { isHumanOutboundMessage } from "../src/lib/queue/lead-history";

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

// Modelo ANTI-ECO (revertido o c2ee2a6 em 2026-06-18, caso Marina): userId é
// reforço, não requisito. No IG tudo vem source=app/userId=null — o que separa
// "fui eu" de "foi outro" é o anti-eco.

// disc 2 — eco da própria IA → NÃO humano (não auto-pausa), mesmo com userId do admin.
eq("eco de parte do envio multi-parte → NÃO humano",
  cl({ lastOutbound: { body: "Oi Pedro! Pra começar, qual seu nome completo?", userId: "admin_123", source: "app" }, aiTexts: aiMsgs }), false);
// disc 4 — IA nunca falou (aiTexts vazio) → NÃO pausa (lead de anúncio/entrada). Marcela Lana.
eq("IA nunca falou (aiTexts vazio) → NÃO humano (Marcela Lana)",
  cl({ lastOutbound: { body: "Que bom que vc chegou até aqui! 😊", userId: "", source: "app" }, aiTexts: [] }), false);
// disc 1 — automação do GHL (welcome) com userId → NÃO humano.
eq("automação (workflow) com userId → NÃO humano",
  cl({ lastOutbound: { body: "Bem-vindo!", userId: "u1", source: "workflow" }, aiTexts: [] }), false);
// disc 3 — humano real com userId, IA já ativa, texto não-eco → humano.
eq("humano real (userId + não-eco, IA já ativa) → humano",
  cl({ lastOutbound: { body: "Oi, aqui é a Márcia, vou assumir daqui", userId: "u9", source: "app" }, aiTexts: aiMsgs }), true);
// disc 6 (CHAVE p/ Marina) — IA já falou + outbound não-eco SEM userId (2º bot/humano
// no IG) → OUTRO assumiu → recua. É o que o c2ee2a6 tinha quebrado (fazia a IA atropelar).
eq("IA já ativa + não-eco SEM userId (2º bot/humano no IG) → humano (recua)",
  cl({ lastOutbound: { body: "e ai? sumiu haha tudo bem por ai?", userId: "", source: "app" }, aiTexts: aiMsgs }), true);
// disc 5 — mídia (sem texto) depois da IA ativa → humano (a IA só manda texto).
eq("mídia sem texto, IA já ativa → humano",
  cl({ lastOutbound: { body: "", userId: "", source: "app" }, aiTexts: aiMsgs }), true);

console.log("\n=== disc 2b: merge field quebrado = automação, NÃO humano (caso Jussara 2026-07-16) ===");
eq("hasUnfilledMergeField 'Oi Nome do Cliente'", hasUnfilledMergeField("Oi Nome do Cliente, seu exame está agendado"), true);
eq("hasUnfilledMergeField '{{contact.name}}'", hasUnfilledMergeField("Olá {{contact.name}}, tudo bem?"), true);
eq("hasUnfilledMergeField '[nome]'", hasUnfilledMergeField("Oi [nome], passando pra lembrar"), true);
eq("hasUnfilledMergeField texto normal → false", hasUnfilledMergeField("Oi Tiago, tudo bem?"), false);
eq("hasUnfilledMergeField colchete comum humano → false", hasUnfilledMergeField("beleza [risos], falo com vc depois"), false);
// A CHAVE do fix: template quebrado COM userId (automação rodando 'como user',
// source=api na conta Stevo) NÃO deve pausar a IA. Antes disso caía no disc 3 (userId → humano).
eq("template quebrado 'Oi Nome do Cliente' + userId + api → NÃO humano (fix Jussara)",
  cl({ lastOutbound: { body: "Oi Nome do Cliente, seu exame está agendado", userId: "OLxJycjn", source: "api" }, aiTexts: aiMsgs }), false);
// NÃO-REGRESSÃO: humano de verdade (Brenda) digitando texto normal na conta Stevo
// (source=api, sem placeholder, IA já falou) → CONTINUA sendo humano (pausa correta).
eq("Brenda texto normal (api, sem placeholder, IA já ativa) → humano (não regride)",
  cl({ lastOutbound: { body: "oi, aqui é a Brenda, deixa comigo", userId: "", source: "api" }, aiTexts: aiMsgs }), true);

console.log("\n=== isHumanOutboundMessage (F37/should-respond) — paridade c/ classifyLastOutbound ===");
const ihm = isHumanOutboundMessage;
// Fix P1 review 2026-06-18: o auto-silêncio da Vandinha (nosso eco source=app lido
// como humano) + a disc-4 (Marcela Lana) que faltava aqui.
eq("eco da própria IA (source=app, bate aiTexts) → NÃO humano (fix Vandinha)",
  ihm({ direction: "outbound", source: "app", body: aiMsgs[0], userId: null }, aiMsgs), false);
eq("disc-4: IA nunca falou (aiTexts vazio) + welcome source=app → NÃO humano (Marcela Lana)",
  ihm({ direction: "outbound", source: "app", body: "Bem-vindo! Como posso ajudar?", userId: null }, []), false);
eq("aiTexts null (não verificável) → NÃO humano (conservador)",
  ihm({ direction: "outbound", source: "app", body: "qualquer", userId: null }, null), false);
eq("automação (workflow) → NÃO humano",
  ihm({ direction: "outbound", source: "workflow", body: "promo", userId: null }, aiMsgs), false);
eq("2º bot/humano: IA já falou + texto não-eco source=app → humano (recua)",
  ihm({ direction: "outbound", source: "app", body: "e ai? sumiu haha tudo bem?", userId: null }, aiMsgs), true);
eq("inbound nunca é humano-outbound",
  ihm({ direction: "inbound", source: "app", body: "oi", userId: null }, aiMsgs), false);

console.log("\n=== sentinela do follow-up [[NAO_ENVIAR]] (gate de decisão sobrevive ao parse) ===");
// Fix P0 review 2026-06-18: parseAIResponse reescreve message:"" → "Pode me contar
// mais?", então o skip via msg vazia era MORTO. O sentinela é texto não-vazio que
// sobrevive ao parse; o runner detecta com este regex e NÃO envia.
const SENTINEL_RE = /\[\[\s*NAO_ENVIAR\s*\]\]/i;
eq("detecta [[NAO_ENVIAR]]", SENTINEL_RE.test("[[NAO_ENVIAR]]"), true);
eq("detecta com espaços [[ NAO_ENVIAR ]]", SENTINEL_RE.test("[[ NAO_ENVIAR ]]"), true);
eq("mensagem normal NÃO casa sentinela", SENTINEL_RE.test("Oi Pedro, tudo bem?"), false);
eq("o default do parse ('Pode me contar mais?') NÃO casa sentinela", SENTINEL_RE.test("Pode me contar mais?"), false);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
