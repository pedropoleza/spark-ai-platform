// Probe na Hub location RBFxlEQZobaDjlF2i5px
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "RBFxlEQZobaDjlF2i5px"; // Hub
const PEDRO_PHONE = "+17867717077";

async function main() {
  const client = new GHLClient(COMPANY, LOC);

  // 1. Acha contact ID do Pedro nessa location (Hub)
  let contactId: string | null = null;
  try {
    const r = await client.post<{
      contacts?: Array<{ id: string; firstName?: string; lastName?: string; phone?: string }>;
    }>("/contacts/search", {
      locationId: LOC,
      query: PEDRO_PHONE,
      pageLimit: 5,
    });
    const c = r.contacts?.[0];
    if (c) {
      contactId = c.id;
      console.log(`✓ Pedro encontrado: ${c.id} (${c.firstName || ""} ${c.lastName || ""}, ${c.phone})`);
    } else {
      console.log(`✗ Pedro NÃO encontrado como contact nessa location.`);
      // Vamos criar o contact temporário pra teste
      const created = await client.post<{ contact?: { id: string } }>("/contacts/", {
        locationId: LOC,
        firstName: "Pedro",
        lastName: "Test",
        phone: PEDRO_PHONE,
      });
      contactId = created.contact?.id || null;
      console.log(`✓ Contact criado: ${contactId}`);
    }
  } catch (e) {
    console.log(`✗ Search/create FAIL: ${e instanceof Error ? e.message.slice(0, 250) : e}`);
    return;
  }

  if (!contactId) {
    console.log("Sem contact ID, abortando.");
    return;
  }

  // 2. Lista phone numbers da location
  try {
    const phones = await client.get<{ phoneNumbers?: Array<{ value: string; title?: string }> }>(
      "/phone-system/numbers/",
      { locationId: LOC },
    );
    console.log(`\nPhone numbers da Hub:`);
    for (const p of phones.phoneNumbers || []) {
      console.log(`  ${p.value} — ${p.title || ""}`);
    }
  } catch (e) {
    console.log(`phones FAIL: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }

  // 3. TESTA enviar 4 payloads
  const tests: Array<{ name: string; body: Record<string, unknown> }> = [
    {
      name: "plain SMS (Stevo)",
      body: {
        type: "SMS",
        contactId,
        message: "[TEST 1/4] plain SMS via Stevo — Pedro me confirma se chegou",
      },
    },
    {
      name: "plain WhatsApp",
      body: {
        type: "WhatsApp",
        contactId,
        message: "[TEST 2/4] plain WhatsApp via Meta API",
      },
    },
    {
      name: "WhatsApp + buttons[]",
      body: {
        type: "WhatsApp",
        contactId,
        message: "[TEST 3/4] Confirma o teste?",
        buttons: [
          { id: "yes", title: "Sim" },
          { id: "no", title: "Não" },
        ],
      },
    },
    {
      name: "WhatsApp + interactive",
      body: {
        type: "WhatsApp",
        contactId,
        message: "[TEST 4/4]",
        interactive: {
          type: "button",
          body: { text: "Funcionou com botões?" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "yes", title: "Sim" } },
              { type: "reply", reply: { id: "no", title: "Não" } },
            ],
          },
        },
      },
    },
  ];

  console.log("\n=== Enviando 4 testes na Hub ===");
  const sent: Array<{ name: string; messageId?: string }> = [];
  for (const t of tests) {
    try {
      const r = await client.post<{ messageId?: string }>("/conversations/messages", t.body);
      console.log(`✅ ${t.name}: messageId=${r.messageId}`);
      sent.push({ name: t.name, messageId: r.messageId });
    } catch (e) {
      console.log(`❌ ${t.name}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }

  // 4. Aguarda 5s e checa delivery status
  await new Promise((r) => setTimeout(r, 5000));

  console.log("\n=== Delivery status (5s depois) ===");
  for (const s of sent) {
    if (!s.messageId) continue;
    try {
      const r = await client.get<{ message?: { status?: string; error?: string } }>(
        `/conversations/messages/${s.messageId}`,
      );
      const m = r.message;
      console.log(`${s.name}: status=${m?.status}, error=${m?.error || "—"}`);
    } catch (e) {
      console.log(`${s.name}: GET FAIL — ${e instanceof Error ? e.message.slice(0, 100) : e}`);
    }
  }
}

main();
