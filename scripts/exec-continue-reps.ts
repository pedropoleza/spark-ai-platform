/**
 * Continua a conversa das 2 reps novas que o SparkBot não respondeu (bug do
 * identifyRep timeout, 2026-06-16). Replaya o "Oi"/"Oiii" delas pelo handler REAL
 * com o código JÁ CORRIGIDO (varredura paralela) → cria o rep_identity + dispara
 * a 1ª resposta (termos com botão Aceito/Não — templated, sem LLM, então roda
 * local sem precisar da chave Anthropic). Idempotente o suficiente: o "Oi" delas
 * nunca criou dedup lock (morreu no scan antes).
 *   npx tsx -r tsconfig-paths/register scripts/exec-continue-reps.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { handleAssistantInbound } from "../src/lib/account-assistant/webhook-handler";

const HUB = "RBFxlEQZobaDjlF2i5px";

const REPS = [
  { name: "Manuela Garcia (Many)", contactId: "Pfx1aJdVRXY1B1V96mhu", conversationId: "7pffSparYgdapT6785jV", text: "Oi" },
  { name: "Ana Paula Lemika", contactId: "yuTMSFsEiWlNdN0pcEmH", conversationId: "kn492JPQdcl3B0Auf9r8", text: "Oiii" },
];

async function main() {
  for (const r of REPS) {
    const started = Date.now();
    try {
      await handleAssistantInbound({
        hubLocationId: HUB,
        contactId: r.contactId,
        conversationId: r.conversationId,
        messageBody: r.text,
        messageType: "Custom",
        direction: "inbound",
        body: {
          body: r.text,
          type: "InboundMessage",
          direction: "inbound",
          messageType: "Custom",
          contactId: r.contactId,
          conversationId: r.conversationId,
          locationId: HUB,
          attachments: [],
        },
      });
      console.log(`✅ ${r.name}: processado em ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`❌ ${r.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("\nDONE — verifica rep_identities + sparkbot_messages abaixo.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
