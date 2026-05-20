/**
 * Golden suite do parser de webhook do Stevo (stevo-parser.ts).
 *
 * Fixtures = os 4 tipos REAIS capturados em prod (text, document csv, image
 * jpeg, ptt audio) + os casos que DEVEM retornar null (IsFromMe, event!=Message,
 * IsGroup). Valida kind, telefone normalizado (+17867717077), mimetype,
 * fileName, e os null-returns.
 *
 * Run: npx tsx -r tsconfig-paths/register scripts/test-stevo-parser.ts
 */
import { parseStevoWebhook } from "@/lib/account-assistant/webhook/stevo-parser";

// base64 de um CSV pequeno ("nome,telefone\nPedro,17867717077\n") — só pra ter
// um binário realista no fixture de documento.
const CSV_B64 = Buffer.from("nome,telefone\nPedro,17867717077\n").toString("base64");
const FAKE_IMG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
const FAKE_OGG_B64 = Buffer.from("OggS-fake-opus-bytes").toString("base64");

const SENDER = "17867717077@s.whatsapp.net";
const INSTANCE_TOKEN = "1777763104179loKqHuxsjRMjD7K5";

function infoBase(overrides: Record<string, unknown>) {
  return {
    ID: "MSG_ID_123",
    Chat: SENDER,
    Sender: SENDER,
    IsFromMe: false,
    IsGroup: false,
    PushName: "Pedro Poleza",
    Timestamp: "2026-05-20T13:15:55-03:00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------
let pass = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: string) {
  total++;
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1. TEXTO (conversation)
// ---------------------------------------------------------------------------
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceName: "sparkbot",
    instanceToken: INSTANCE_TOKEN,
    serverUrl: "https://smv2-3.stevo.chat",
    data: {
      Info: infoBase({ Type: "text", MediaType: "" }),
      Message: { conversation: "oi sparkbot" },
    },
  });
  check("texto: retorna objeto", r !== null);
  check("texto: kind=text", r?.kind === "text");
  check("texto: text correto", r?.kind === "text" && r.text === "oi sparkbot");
  check("texto: phone normalizado +17867717077", r?.phone === "+17867717077", `got=${r?.phone}`);
  check("texto: messageId", r?.messageId === "MSG_ID_123");
  check("texto: pushName", r?.pushName === "Pedro Poleza");
  check("texto: instanceToken", r?.instanceToken === INSTANCE_TOKEN);
  check("texto: serverUrl extraído", r?.serverUrl === "https://smv2-3.stevo.chat", `got=${r?.serverUrl}`);
  check("texto: instanceName extraído", r?.instanceName === "sparkbot", `got=${r?.instanceName}`);
}

// serverUrl ausente → string vazia (não quebra o parse).
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: { Info: infoBase({ Type: "text", MediaType: "" }), Message: { conversation: "x" } },
  });
  check("serverUrl ausente → ''", r?.serverUrl === "");
}

// ---------------------------------------------------------------------------
// 1b. TEXTO (extendedTextMessage.text — variante)
// ---------------------------------------------------------------------------
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "text", MediaType: "" }),
      Message: { extendedTextMessage: { text: "texto longo aqui" } },
    },
  });
  check("texto extended: kind=text", r?.kind === "text");
  check("texto extended: text correto", r?.kind === "text" && r.text === "texto longo aqui");
}

// ---------------------------------------------------------------------------
// 2. DOCUMENTO (csv)
// ---------------------------------------------------------------------------
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "media", MediaType: "document" }),
      Message: {
        documentMessage: { fileName: "x.csv", mimetype: "text/csv", caption: "Arquivo", fileLength: 7652 },
        base64: CSV_B64,
      },
    },
  });
  check("documento: kind=document", r?.kind === "document");
  check("documento: mimetype text/csv", r?.kind === "document" && r.mimetype === "text/csv");
  check("documento: fileName x.csv", r?.kind === "document" && r.fileName === "x.csv");
  check("documento: caption", r?.kind === "document" && r.caption === "Arquivo");
  check("documento: base64 presente", r?.kind === "document" && r.base64 === CSV_B64);
  check("documento: phone normalizado", r?.phone === "+17867717077");
}

// ---------------------------------------------------------------------------
// 3. IMAGEM (jpeg)
// ---------------------------------------------------------------------------
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "media", MediaType: "image" }),
      Message: {
        imageMessage: { mimetype: "image/jpeg", caption: "Imagem" },
        base64: FAKE_IMG_B64,
      },
    },
  });
  check("imagem: kind=image", r?.kind === "image");
  check("imagem: mimetype image/jpeg", r?.kind === "image" && r.mimetype === "image/jpeg");
  check("imagem: caption", r?.kind === "image" && r.caption === "Imagem");
  check("imagem: base64 presente", r?.kind === "image" && r.base64 === FAKE_IMG_B64);
}

// ---------------------------------------------------------------------------
// 4. ÁUDIO (ptt)
// ---------------------------------------------------------------------------
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "media", MediaType: "ptt" }),
      Message: {
        audioMessage: { PTT: true, mimetype: "audio/ogg; codecs=opus", seconds: 9 },
        base64: FAKE_OGG_B64,
      },
    },
  });
  check("audio: kind=audio", r?.kind === "audio");
  check("audio: mimetype ogg/opus", r?.kind === "audio" && r.mimetype === "audio/ogg; codecs=opus");
  check("audio: seconds=9", r?.kind === "audio" && r.seconds === 9);
  check("audio: base64 presente", r?.kind === "audio" && r.base64 === FAKE_OGG_B64);
}

// ---------------------------------------------------------------------------
// 5. RESPOSTA DE BOTÃO (buttons_response) — formato real capturado
// ---------------------------------------------------------------------------
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "media", MediaType: "buttons_response" }),
      Message: {
        buttonsResponseMessage: {
          type: 1,
          Response: { SelectedDisplayText: "Confirmar ✅" },
          contextInfo: {
            stanzaID: "3EB0BTN",
            quotedMessage: {
              interactiveMessage: { body: { text: "*Confirmação*\n\nVou mandar pro João. Confirma?" } },
            },
          },
          selectedButtonID: "confirm_yes",
        },
      },
    },
  });
  check("botão resp: kind=interactive", r?.kind === "interactive");
  check("botão resp: type=button", r?.kind === "interactive" && r.interactiveType === "button");
  check("botão resp: text=display", r?.kind === "interactive" && r.text === "Confirmar ✅");
  check("botão resp: selectionId", r?.kind === "interactive" && r.selectionId === "confirm_yes");
  check("botão resp: stanza", r?.kind === "interactive" && r.replyToStanzaId === "3EB0BTN");
  check(
    "botão resp: quotedText (sem *, espaços normalizados)",
    r?.kind === "interactive" && r.quotedText === "Confirmação Vou mandar pro João. Confirma?",
    r?.kind === "interactive" ? r.quotedText : "",
  );
}

// ---------------------------------------------------------------------------
// 6. RESPOSTA DE LISTA (list_response) — formato real capturado
// ---------------------------------------------------------------------------
{
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "media", MediaType: "list_response" }),
      Message: {
        listResponseMessage: {
          title: "Opção 2",
          contextInfo: {
            stanzaID: "3EB0LST",
            quotedMessage: { listMessage: { title: "Escolha", description: "Qual contato?" } },
          },
          singleSelectReply: { selectedRowID: "opt_2" },
        },
      },
    },
  });
  check("lista resp: kind=interactive", r?.kind === "interactive");
  check("lista resp: type=list", r?.kind === "interactive" && r.interactiveType === "list");
  check("lista resp: text=title", r?.kind === "interactive" && r.text === "Opção 2");
  check("lista resp: selectionId=rowID", r?.kind === "interactive" && r.selectionId === "opt_2");
  check("lista resp: stanza", r?.kind === "interactive" && r.replyToStanzaId === "3EB0LST");
  check("lista resp: quotedText=description", r?.kind === "interactive" && r.quotedText === "Qual contato?");
}

// ---------------------------------------------------------------------------
// NULL RETURNS
// ---------------------------------------------------------------------------
{
  // IsFromMe=true → null (eco da própria msg)
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "text", MediaType: "", IsFromMe: true }),
      Message: { conversation: "minha própria msg" },
    },
  });
  check("IsFromMe=true → null", r === null);
}
{
  // event != Message → null
  const r = parseStevoWebhook({
    event: "Connection",
    instanceToken: INSTANCE_TOKEN,
    data: { Info: infoBase({ Type: "text", MediaType: "" }), Message: { conversation: "x" } },
  });
  check("event!=Message → null", r === null);
}
{
  // IsGroup=true → null
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: {
      Info: infoBase({ Type: "text", MediaType: "", IsGroup: true }),
      Message: { conversation: "msg de grupo" },
    },
  });
  check("IsGroup=true → null", r === null);
}
{
  // Conteúdo irreconhecível (sem texto/mídia) → null
  const r = parseStevoWebhook({
    event: "Message",
    instanceToken: INSTANCE_TOKEN,
    data: { Info: infoBase({ Type: "text", MediaType: "" }), Message: {} },
  });
  check("conteúdo vazio → null", r === null);
}
{
  // body não-objeto → null
  check("body null → null", parseStevoWebhook(null) === null);
  check("body string → null", parseStevoWebhook("nope") === null);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
