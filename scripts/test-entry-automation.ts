/**
 * Testa a decisão de "silêncio na entrada por automação" (healthcheck five star
 * ricos 2026-07-23, caso Kayla/Márcia).
 *   npx tsx -r tsconfig-paths/register scripts/test-entry-automation.ts
 */
import { shouldSuppressEntry, messageHasIntakeSignal } from "@/lib/queue/entry-automation";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// A mensagem REAL do anúncio (contact RtHdtafEXWEVrKisjdAr em prod).
const AD_MSG = `📢 Veio de anúncio (facebook): "Márcia Oliveira"\nhttps://fb.me/6XHSTG7VC\n\nQuero entender como funciona o seguro com benefício em vida.`;

console.log("\n[messageHasIntakeSignal]");
check("mensagem do anúncio NÃO tem sinal de dado (fb.me não conta)", messageHasIntakeSignal(AD_MSG) === false, AD_MSG);
check("'quero entender como funciona' sozinho não tem sinal", messageHasIntakeSignal("quero entender como funciona o seguro") === false);
check("data de nascimento tem sinal", messageHasIntakeSignal("nasci em 12/05/1980"));
check("ano tem sinal", messageHasIntakeSignal("sou de 1975"));
check("idade tem sinal", messageHasIntakeSignal("tenho 45 anos, moro em Orlando"));
check("telefone tem sinal", messageHasIntakeSignal("meu whats é 4071234567"));
check("pedido de horário tem sinal", messageHasIntakeSignal("podemos agendar amanhã?"));
check("'que horas' tem sinal", messageHasIntakeSignal("que horas você tem disponível?"));
check("saudação simples não tem sinal", messageHasIntakeSignal("oi, tudo bem?") === false);

console.log("\n[shouldSuppressEntry — modo ON]");
const base = { enabled: true, conversationActive: false, entrySuppressedAt: null, isProactive: false };
check("1ª msg do anúncio → SILENCIA", shouldSuppressEntry({ ...base, messageText: AD_MSG }) === true);
check("1ª msg com dados → NÃO silencia (salvaguarda)", shouldSuppressEntry({ ...base, messageText: "nasci 12/05/1980, moro em SP, não fumo" }) === false);
check("1ª msg pedindo horário → NÃO silencia", shouldSuppressEntry({ ...base, messageText: "quero agendar" }) === false);
check("conversa já ativa → NÃO silencia (IA assume)", shouldSuppressEntry({ ...base, conversationActive: true, messageText: AD_MSG }) === false);
check("entrada já silenciada antes → NÃO silencia de novo (2ª msg)", shouldSuppressEntry({ ...base, entrySuppressedAt: "2026-07-24T00:00:00Z", messageText: "oi, ainda tá aí?" }) === false);
check("fluxo proativo → NÃO silencia", shouldSuppressEntry({ ...base, isProactive: true, messageText: AD_MSG }) === false);

console.log("\n[shouldSuppressEntry — modo OFF (paridade)]");
check("flag OFF → nunca silencia (mesmo na entrada)", shouldSuppressEntry({ ...base, enabled: false, messageText: AD_MSG }) === false);
check("flag null → nunca silencia", shouldSuppressEntry({ ...base, enabled: null, messageText: AD_MSG }) === false);
check("flag undefined → nunca silencia", shouldSuppressEntry({ ...base, enabled: undefined, messageText: AD_MSG }) === false);

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam\n`);
process.exit(fail === 0 ? 0 : 1);
