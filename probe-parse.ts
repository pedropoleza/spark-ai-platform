import { parseWebhookCommand } from "./src/lib/account-assistant/webhook-commands/parse";
import { fingerprintComando } from "./src/lib/account-assistant/webhook-commands/audit";

const LOC = "JhuP409NhSBHmYW4RzNi";
const CORRETOR = "+17867717077";
const LEAD = "+15615551234";

function show(nome: string, body: unknown) {
  const r = parseWebhookCommand(body);
  console.log(`\n### ${nome}`);
  console.log(JSON.stringify(r, null, 2).slice(0, 700));
}

// A) payload GHL com `type` na raiz + os campos documentados no customData
show("A) root type=ContactCreate + customData completo", {
  location: { id: LOC, name: "Fabiana" },
  type: "ContactCreate",
  contact_id: "ct_1",
  phone: LEAD,
  customData: { message_type: "notification", send_to: CORRETOR, message: "Lead novo pediu retorno." },
});

// B) payload GHL de mensagem: messageType na raiz
show("B) root messageType=SMS + customData completo", {
  locationId: LOC,
  type: "InboundMessage",
  messageType: "SMS",
  body: "quero cancelar",
  contactId: "ct_1",
  customData: { message_type: "notification", send_to: CORRETOR, message: "O lead respondeu no SMS." },
});

// C) só body na raiz (sem chave de tipo na raiz) + customData
show("C) root body=texto do lead + customData.message", {
  location: { id: LOC },
  body: "quero cancelar, me tira da lista",
  customData: { message_type: "notification", send_to: CORRETOR, message: "O lead respondeu — dá um retorno." },
});

// D) root `to` vs customData send_to
show("D) root to=<lead> + customData.send_to=<corretor>", {
  location: { id: LOC },
  to: LEAD,
  customData: { message_type: "notification", send_to: CORRETOR, message: "aviso" },
});

// E) send_to merge field não resolvido + `to` na raiz
show("E) send_to merge field + root to", {
  location_id: LOC,
  message_type: "notification",
  message: "aviso",
  send_to: "{{custom_values.telefone_corretor}}",
  to: LEAD,
});

// F) prompt no customData mas message na raiz
show("F) modo prompt: root message vs customData.prompt", {
  location_id: LOC,
  message: "texto qualquer da raiz",
  customData: { message_type: "prompt", prompt: "Resume esse lead.", send_to: CORRETOR },
});

// G) telefone como número JSON
show("G) send_to como número JSON", {
  location_id: LOC, message_type: "notification", message: "aviso", send_to: 17867717077,
});

// H) mensagem parcialmente resolvida cai pro próximo campo
show("H) message com merge field não resolvido + text na raiz", {
  location_id: LOC,
  message_type: "notification",
  message: "Oi, o lead {{contact.first_name}} pediu retorno.",
  text: "OUTRA COISA",
  send_to: CORRETOR,
});

// I) secret no customData + token na raiz
show("I) root token + customData.secret", {
  location_id: LOC, message_type: "notification", message: "oi", send_to: CORRETOR,
  token: "eyJhbGciOi-token-do-form",
  customData: { secret: "s3gr3d0-do-pedro" },
});

// J) fingerprint ignora contactId (modo prompt)
const base = {
  locationId: LOC, kind: "prompt" as const, message: "Resume esse lead e diz o próximo passo.",
  sendTo: CORRETOR, contactId: "ct_AAA", contactName: "Ana", requestId: null, secret: null,
};
console.log("\n### J) fingerprint com contactId diferente");
console.log("iguais?", fingerprintComando(base) === fingerprintComando({ ...base, contactId: "ct_BBB", contactName: "Bruno" }));
