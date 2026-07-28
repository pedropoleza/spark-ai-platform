/**
 * Testes do fix "robô parou do nada" (Alves Cury 2026-07-28): atividade do CRM
 * e ligação não podem ser lidas como "humano assumiu a conversa".
 *
 * Reproduz a timeline REAL do contato sL5oCpvfiqKh4SD7sLxL (print da dona).
 *
 * Rodar: npx tsx scripts/test-activity-not-human.ts
 */
import { isChatMessageType } from "../src/lib/ghl/message-sources";
import { isHumanOutboundMessage } from "../src/lib/queue/lead-history";
import { classifyLastOutbound } from "../src/lib/queue/human-takeover";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nisChatMessageType");
check("TYPE_ACTIVITY_OPPORTUNITY não é chat", isChatMessageType("TYPE_ACTIVITY_OPPORTUNITY") === false);
check("TYPE_ACTIVITY_APPOINTMENT não é chat", isChatMessageType("TYPE_ACTIVITY_APPOINTMENT") === false);
check("TYPE_CAMPAIGN_CALL não é chat", isChatMessageType("TYPE_CAMPAIGN_CALL") === false);
check("TYPE_CALL não é chat", isChatMessageType("TYPE_CALL") === false);
check("TYPE_VOICEMAIL não é chat", isChatMessageType("TYPE_VOICEMAIL") === false);
check("TYPE_WHATSAPP é chat", isChatMessageType("TYPE_WHATSAPP") === true);
check("TYPE_INSTAGRAM é chat", isChatMessageType("TYPE_INSTAGRAM") === true);
check("TYPE_CUSTOM_SMS é chat", isChatMessageType("TYPE_CUSTOM_SMS") === true);
check("sem tipo → assume chat (legado)", isChatMessageType(undefined) === true);

console.log("\nTimeline REAL do caso (contato sL5oCpvfiqKh4SD7sLxL, 28/07 15:04)");
const aiTexts = [
  "Legal! Seguro com benefício em vida é exatamente o que a gente trabalha.",
  "Me conta, vc ta falando de qual estado?",
];
const aiIds = ["hSZlkbeYZL0LxapPRaBy", "T71na18GPmrdFV1aSyai"];

// O culpado: "Opportunity created" (atividade do CRM), source app, sem userId.
check(
  "'Opportunity created' NÃO é humano (era o bug)",
  isHumanOutboundMessage(
    { direction: "outbound", messageType: "TYPE_ACTIVITY_OPPORTUNITY", source: "app", body: "Opportunity created", userId: null, id: "act1" },
    aiTexts,
    aiIds,
  ) === false,
);
check(
  "ligação do workflow NÃO é humano",
  isHumanOutboundMessage(
    { direction: "outbound", messageType: "TYPE_CAMPAIGN_CALL", source: "workflow", body: "", userId: "TrBViEwf", id: "call1" },
    aiTexts,
    aiIds,
  ) === false,
);
check(
  "ligação MANUAL do rep também não cala o chat",
  isHumanOutboundMessage(
    { direction: "outbound", messageType: "TYPE_CALL", source: "app", body: "", userId: "TrBViEwf", id: "call2" },
    aiTexts,
    aiIds,
  ) === false,
);
check(
  "msg da IA por ID → não é humano (H56 agora no gate F37)",
  isHumanOutboundMessage(
    { direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", body: "texto MANGLEADO pelo canal", userId: "TrBViEwf", id: "hSZlkbeYZL0LxapPRaBy" },
    aiTexts,
    aiIds,
  ) === false,
);
check(
  "msg da IA por TEXTO → não é humano (retrocompat sem ids)",
  isHumanOutboundMessage(
    { direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", body: aiTexts[1], userId: "TrBViEwf", id: "outro" },
    aiTexts,
  ) === false,
);
check(
  "REP DE VERDADE digitando ainda É humano (não regrediu)",
  isHumanOutboundMessage(
    { direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", body: "hoje voce trabalha com o que ai em MA?", userId: "TrBViEwf", id: "human1" },
    aiTexts,
    aiIds,
  ) === true,
);

console.log("\nF52 (classifyLastOutbound) segue coerente");
check(
  "id nosso → não humano",
  classifyLastOutbound({
    lastOutbound: { id: "hSZlkbeYZL0LxapPRaBy", body: "qualquer", userId: "TrBViEwf", source: "app" },
    aiTexts,
    sentIds: aiIds,
  }).isHuman === false,
);
check(
  "rep real → humano",
  classifyLastOutbound({
    lastOutbound: { id: "human1", body: "hoje voce trabalha com o que ai em MA?", userId: "TrBViEwf", source: "app" },
    aiTexts,
    sentIds: aiIds,
  }).isHuman === true,
);

console.log("\nWiring: o F52 não olha mais atividade/ligação");
import { readFileSync } from "fs";
import { resolve } from "path";
const qp = readFileSync(resolve(__dirname, "..", "src/lib/queue/queue-processor.ts"), "utf8");
check("lastOutbound filtra por isChatMessageType", qp.includes("isChatMessageType((m as { messageType?: string }).messageType)"));
const lh = readFileSync(resolve(__dirname, "..", "src/lib/queue/lead-history.ts"), "utf8");
check("lead-history passa aiIds", lh.includes("isHumanOutboundMessage(m, aiTexts, aiIds)"));
check("recent_messages carrega id", lh.includes("id: typeof m.id === \"string\" ? m.id : undefined"));

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
