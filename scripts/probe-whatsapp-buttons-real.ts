// Probe REAL — envia mensagens pro Pedro (com autorização explícita)
// pra descobrir se GHL API REST aceita WhatsApp interactive.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "H09HtG22LZzTU8htMxxg";
const PEDRO_CONTACT = "UeFO5h5fGJQF6lACMSfj";

async function tryPayload(
  name: string,
  body: Record<string, unknown>,
  willActuallySend: boolean,
) {
  const flag = willActuallySend ? "🚨 PODE ENVIAR REAL" : "🔬 SCHEMA TEST";
  console.log(`\n=== ${flag}: ${name} ===`);
  console.log("payload:", JSON.stringify(body).slice(0, 200));
  const client = new GHLClient(COMPANY, LOC);
  try {
    const r = await client.post<{
      conversationId?: string;
      messageId?: string;
      messageIds?: string[];
    }>("/conversations/messages", body);
    console.log(`✅ ${name}: SUCCESS`);
    console.log(`   response:`, JSON.stringify(r).slice(0, 400));
    return { ok: true, response: r };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`❌ ${name}:`, msg.slice(0, 400));
    return { ok: false, error: msg };
  }
}

async function main() {
  console.log("=== WhatsApp interactive probe — REAL ENVIO autorizado pelo Pedro ===\n");

  // 1. SCHEMA TEST: WhatsApp_Template type — sem template real → erro de schema (não envia)
  await tryPayload("WhatsApp_Template type", {
    type: "WhatsApp_Template",
    contactId: PEDRO_CONTACT,
    templateName: "test_nonexistent_template",
    languageCode: "pt_BR",
  }, false);

  // 2. SCHEMA TEST: type='interactive' (Meta format) → provavelmente 400
  await tryPayload("type=interactive (Meta format)", {
    type: "interactive",
    contactId: PEDRO_CONTACT,
    interactive: {
      type: "button",
      body: { text: "test" },
      action: {
        buttons: [{ type: "reply", reply: { id: "yes", title: "Sim" } }],
      },
    },
  }, false);

  // 3. SCHEMA TEST: type='WhatsApp_Interactive' (talvez existe)
  await tryPayload("WhatsApp_Interactive", {
    type: "WhatsApp_Interactive",
    contactId: PEDRO_CONTACT,
    message: "test",
  }, false);

  // 4. SCHEMA TEST: WhatsApp + buttons[] (estilo simplificado)
  await tryPayload("WhatsApp + buttons[]", {
    type: "WhatsApp",
    contactId: PEDRO_CONTACT,
    message: "Escolha:",
    buttons: [
      { id: "yes", title: "Sim" },
      { id: "no", title: "Não" },
    ],
  }, true); // se aceitar, manda

  // 5. SCHEMA TEST: WhatsApp + interactive object
  await tryPayload("WhatsApp + interactive object", {
    type: "WhatsApp",
    contactId: PEDRO_CONTACT,
    message: "Escolha:",
    interactive: {
      type: "button",
      body: { text: "Confirma teste?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "yes", title: "Sim" } },
          { type: "reply", reply: { id: "no", title: "Não" } },
        ],
      },
    },
  }, true); // se aceitar, manda

  // 6. BASELINE: plain WhatsApp (sabemos que falha sem subscription Meta)
  await tryPayload("plain WhatsApp (baseline)", {
    type: "WhatsApp",
    contactId: PEDRO_CONTACT,
    message: "[TEST] baseline WhatsApp via API",
  }, true);

  // 7. BASELINE: plain SMS (sabemos que vai via Stevo)
  await tryPayload("plain SMS (Stevo/Evolution)", {
    type: "SMS",
    contactId: PEDRO_CONTACT,
    message: "[TEST] baseline SMS — chega via Stevo/Evolution no WhatsApp",
  }, true);
}

main().catch((err) => {
  console.error("Falha:", err);
  process.exit(1);
});
