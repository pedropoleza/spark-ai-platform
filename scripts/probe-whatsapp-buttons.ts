// Probe — testa se GHL /conversations/messages aceita WhatsApp interactive
// (buttons, quick replies, lista). NÃO envia pra ninguém — usa contact_id
// fake pra capturar response 400 com hint do schema.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "H09HtG22LZzTU8htMxxg"; // Pedro

// Vamos primeiro descobrir o contact_id REAL do Pedro (+17867717077)
// pra teste real OPCIONAL no fim
const PEDRO_PHONE = "+17867717077";

async function tryPayload(name: string, body: Record<string, unknown>) {
  const client = new GHLClient(COMPANY, LOC);
  try {
    const r = await client.post("/conversations/messages", body);
    console.log(`✅ ${name}: SUCCESS`, JSON.stringify(r).slice(0, 200));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`❌ ${name}:`, msg.slice(0, 300));
  }
}

async function main() {
  // Descobre contact id real do Pedro
  const client = new GHLClient(COMPANY, LOC);
  let pedroContactId: string | null = null;
  try {
    const r = await client.post<{ contacts?: Array<{ id: string; firstName?: string }> }>(
      "/contacts/search",
      {
        locationId: LOC,
        query: PEDRO_PHONE,
        pageLimit: 5,
      },
    );
    pedroContactId = r.contacts?.[0]?.id || null;
    console.log(`Contact ID Pedro: ${pedroContactId || "NOT FOUND"}`);
  } catch (e) {
    console.log("contact search FAIL:", e instanceof Error ? e.message.slice(0, 200) : e);
  }

  console.log("\n=== Probing payload shapes (com contact_id fake pra ver schema error) ===\n");

  const FAKE = "INVALID_ID_TEST_ONLY";

  // 1. Plain WhatsApp (baseline)
  await tryPayload("plain WhatsApp", {
    type: "WhatsApp",
    contactId: FAKE,
    message: "test",
  });

  // 2. WhatsApp_Template (Meta template)
  await tryPayload("WhatsApp_Template", {
    type: "WhatsApp_Template",
    contactId: FAKE,
    templateName: "test_template",
    languageCode: "pt_BR",
  });

  // 3. WhatsApp + interactive (Meta-style buttons)
  await tryPayload("WhatsApp + interactive", {
    type: "WhatsApp",
    contactId: FAKE,
    message: "Escolha:",
    interactive: {
      type: "button",
      body: { text: "Escolha uma opção" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "yes", title: "Sim" } },
          { type: "reply", reply: { id: "no", title: "Não" } },
        ],
      },
    },
  });

  // 4. WhatsApp + buttons direto
  await tryPayload("WhatsApp + buttons[]", {
    type: "WhatsApp",
    contactId: FAKE,
    message: "Escolha:",
    buttons: [
      { id: "yes", title: "Sim" },
      { id: "no", title: "Não" },
    ],
  });

  // 5. SMS + buttons (claro que não, mas pra confirmar)
  await tryPayload("SMS + buttons", {
    type: "SMS",
    contactId: FAKE,
    message: "Escolha: Sim ou Não?",
    buttons: [{ id: "yes", title: "Sim" }],
  });

  // 6. type=interactive (algumas APIs usam isso)
  await tryPayload("type=interactive", {
    type: "interactive",
    contactId: FAKE,
    message: "test",
  });

  // 7. Template com components/buttons (Meta format)
  await tryPayload("template + components", {
    type: "WhatsApp",
    contactId: FAKE,
    template: {
      name: "test",
      language: { code: "pt_BR" },
      components: [
        {
          type: "button",
          sub_type: "quick_reply",
          index: 0,
          parameters: [{ type: "payload", payload: "yes" }],
        },
      ],
    },
  });

  if (pedroContactId) {
    console.log(`\n=== Contact Pedro encontrado: ${pedroContactId} ===`);
    console.log("Pra teste REAL com envio descomente o bloco abaixo no script");
  }
}

main();
