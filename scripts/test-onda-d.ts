/**
 * Testes da Onda D (2026-07-23): anti-eco do handoff por ID de mensagem
 * (caso Marina — auto-pausa falsa em IG) + extractAiSentIds.
 *
 * Rodar: npx tsx scripts/test-onda-d.ts
 */
import { classifyLastOutbound, extractAiSentIds, extractAiSentTexts } from "../src/lib/queue/human-takeover";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\nD2 — anti-eco por ID (classifyLastOutbound)");

// Caso Marina: em IG o corpo não bate (mangle) e userId vem vazio, MAS o id do
// último outbound é um que a IA enviou → NÃO é humano (era o falso-positivo).
check(
  "id do outbound ∈ sentIds → NÃO é humano (mesmo com texto que não casa e userId vazio)",
  classifyLastOutbound({
    lastOutbound: { id: "msg_abc", body: "A agenda dela tá concorrida, encaixo quinta 😉", userId: null, source: "app" },
    aiTexts: ["Na verdade aqui é a Isabella, assessora da Marina"], // texto ANTIGO, não casa
    sentIds: ["msg_abc", "msg_def"],
  }).isHuman === false,
);
check(
  "id NÃO ∈ sentIds + texto não casa + userId vazio (IG) → humano (comportamento antigo preservado)",
  classifyLastOutbound({
    lastOutbound: { id: "msg_humano", body: "Oi, aqui é a Marina, deixa eu assumir!", userId: null, source: "app" },
    aiTexts: ["mensagem antiga da IA que não casa"],
    sentIds: ["msg_abc"],
  }).isHuman === true,
);
check(
  "id ∈ sentIds vence até automação/userId (é nosso, ponto)",
  classifyLastOutbound({
    lastOutbound: { id: "msg_x", body: "qualquer", userId: "user_1", source: "workflow" },
    aiTexts: [],
    sentIds: ["msg_x"],
  }).isHuman === false,
);
check(
  "sem sentIds (caller antigo) → cai no anti-eco por texto (retrocompat)",
  classifyLastOutbound({
    lastOutbound: { body: "Perfeito! Vou te mandar o link", userId: null, source: "app" },
    aiTexts: ["Perfeito! Vou te mandar o link"],
  }).isHuman === false,
);
check(
  "sem sentIds + texto casa por substring → NÃO humano (retrocompat)",
  classifyLastOutbound({
    lastOutbound: { body: "Perfeito! Vou te mandar o link do encontro", userId: null, source: "app" },
    aiTexts: ["Perfeito! Vou te mandar o link do encontro com a Marina amanhã"],
  }).isHuman === false,
);
check(
  "id vazio + sentIds presente mas texto casa → NÃO humano (texto ainda vale)",
  classifyLastOutbound({
    lastOutbound: { id: null, body: "Combinado, te espero lá!", userId: null, source: "app" },
    aiTexts: ["Combinado, te espero lá!"],
    sentIds: ["msg_outro"],
  }).isHuman === false,
);
check(
  "humano REAL com userId (canal com userId, ex WhatsApp) → humano (guard preservado)",
  classifyLastOutbound({
    lastOutbound: { id: "msg_h", body: "Deixa que eu falo com esse lead", userId: "user_sdr", source: "app" },
    aiTexts: ["oi tudo bem"],
    sentIds: ["msg_a", "msg_b"],
  }).isHuman === true,
);
check(
  "IA nunca falou (aiTexts vazio) + id não bate → NÃO humano (branch Marcela Lana preservado)",
  classifyLastOutbound({
    lastOutbound: { id: "msg_welcome", body: "Bem-vindo! Como posso ajudar?", userId: null, source: "app" },
    aiTexts: [],
    sentIds: [],
  }).isHuman === false,
);

console.log("\nD2 — extractAiSentIds");
check(
  "extrai message_ids de payloads (array)",
  JSON.stringify(extractAiSentIds([
    { action_payload: { message: ["oi"], message_ids: ["m1", "m2"] } },
    { action_payload: { message: ["tchau"], message_ids: ["m3"] } },
  ])) === JSON.stringify(["m1", "m2", "m3"]),
);
check(
  "ignora payload sem message_ids (log antigo pré-fix)",
  extractAiSentIds([{ action_payload: { message: ["oi"] } }]).length === 0,
);
check("null/undefined → []", extractAiSentIds(null).length === 0 && extractAiSentIds(undefined).length === 0);
check(
  "filtra ids não-string / vazios",
  JSON.stringify(extractAiSentIds([{ action_payload: { message_ids: ["m1", "", null, 5, "m2"] } }])) === JSON.stringify(["m1", "m2"]),
);
check(
  "extractAiSentTexts segue funcionando (regressão)",
  JSON.stringify(extractAiSentTexts([{ action_payload: { message: ["a", "b"] } }])) === JSON.stringify(["a", "b"]),
);

// Verificações estáticas dos outros pontos da onda
console.log("\nD1a/D2 — verificações estáticas");
import { readFileSync } from "fs";
import { resolve } from "path";
const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
check("action-executor captura + loga message_ids", read("src/lib/ai/action-executor.ts").includes("message_ids: messageIds"));
check("follow-up-scheduler captura sentMessageId", read("src/lib/queue/follow-up-scheduler.ts").includes("sentMessageId = sentFu.messageId"));
check("queue-processor passa sentIds no F52", read("src/lib/queue/queue-processor.ts").includes("sentIds: extractAiSentIds(aiSends)"));
check("D1a: sweepNotifyBlockedOwners existe", read("src/lib/billing/wallet-block.ts").includes("export async function sweepNotifyBlockedOwners"));
check("D1a: cron billing-retry chama o sweep", read("src/app/api/cron/billing-retry/route.ts").includes("sweepNotifyBlockedOwners()"));

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
