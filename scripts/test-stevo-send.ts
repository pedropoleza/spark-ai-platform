/**
 * Golden suite do envio via Stevo (stevo-send.ts) — SEM rede real.
 *
 * Mocka global.fetch pra capturar URL/headers/body e simular respostas do
 * Stevo. Valida: normalização do número, shape do payload (/send/text, header
 * apikey, body {number,text}), splitter multi-bolha (`---`), extração de ID,
 * tratamento de erro (HTTP != 2xx), params inválidos (não chama fetch), e
 * agregação ok/sent/total.
 *
 * Run: npx tsx -r tsconfig-paths/register scripts/test-stevo-send.ts
 */
import {
  sendStevoText,
  normalizeStevoNumber,
  sendStevoButton,
  sendStevoList,
} from "@/lib/account-assistant/webhook/stevo-send";

// ---------------------------------------------------------------------------
// Mock de fetch
// ---------------------------------------------------------------------------
type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[] = [];
let responder: (callIndex: number) => Response = () =>
  new Response(JSON.stringify({ key: { id: "MID_DEFAULT" } }), { status: 200 });

const realFetch = global.fetch;
// @ts-expect-error — substituição controlada pro teste
global.fetch = async (url: unknown, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const idx = calls.length;
  calls.push({
    url: String(url),
    method: init?.method || "GET",
    headers: (init?.headers as Record<string, string>) || {},
    body: init?.body ? JSON.parse(init.body) : {},
  });
  return responder(idx);
};

function reset(r?: (i: number) => Response) {
  calls = [];
  if (r) responder = r;
  else responder = () => new Response(JSON.stringify({ key: { id: "MID_DEFAULT" } }), { status: 200 });
}

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

const BASE = "https://smv2-3.stevo.chat";
const KEY = "1777763104179loKqHuxsjRMjD7K5";

async function run() {
  // -------------------------------------------------------------------------
  // 1. normalizeStevoNumber
  // -------------------------------------------------------------------------
  check("normalize: +17867717077 → 17867717077", normalizeStevoNumber("+17867717077") === "17867717077");
  check("normalize: JID → só dígitos", normalizeStevoNumber("17867717077@s.whatsapp.net") === "17867717077");
  check("normalize: já limpo", normalizeStevoNumber("5511999998888") === "5511999998888");
  check("normalize: vazio → ''", normalizeStevoNumber("") === "");

  // -------------------------------------------------------------------------
  // 2. Envio simples — shape do payload
  // -------------------------------------------------------------------------
  reset();
  {
    const r = await sendStevoText({ serverUrl: BASE, apiKey: KEY, number: "+17867717077", text: "oi rep" });
    check("simples: ok", r.ok, JSON.stringify(r));
    check("simples: sent=1 total=1", r.sent === 1 && r.total === 1);
    check("simples: 1 fetch", calls.length === 1);
    check("simples: URL /send/text", calls[0]?.url === `${BASE}/send/text`, calls[0]?.url);
    check("simples: method POST", calls[0]?.method === "POST");
    check("simples: header apikey", calls[0]?.headers["apikey"] === KEY);
    check("simples: header content-type json", /application\/json/.test(calls[0]?.headers["Content-Type"] || ""));
    check("simples: body.number normalizado", calls[0]?.body.number === "17867717077", String(calls[0]?.body.number));
    check("simples: body.text", calls[0]?.body.text === "oi rep");
    check("simples: sem delay por padrão", calls[0]?.body.delay === undefined);
    check("simples: id extraído", r.ids[0] === "MID_DEFAULT", JSON.stringify(r.ids));
  }

  // -------------------------------------------------------------------------
  // 3. trailing slash no serverUrl é normalizado
  // -------------------------------------------------------------------------
  reset();
  {
    await sendStevoText({ serverUrl: `${BASE}/`, apiKey: KEY, number: "17867717077", text: "x" });
    check("trailing slash: URL sem // duplo", calls[0]?.url === `${BASE}/send/text`, calls[0]?.url);
  }

  // -------------------------------------------------------------------------
  // 4. Splitter — `---` vira múltiplas bolhas
  // -------------------------------------------------------------------------
  reset((i) => new Response(JSON.stringify({ id: `MID_${i}` }), { status: 200 }));
  {
    const r = await sendStevoText({
      serverUrl: BASE,
      apiKey: KEY,
      number: "17867717077",
      text: "primeira bolha\n---\nsegunda bolha",
    });
    check("splitter: 2 fetches", calls.length === 2, `got=${calls.length}`);
    check("splitter: bolha 1", calls[0]?.body.text === "primeira bolha");
    check("splitter: bolha 2", calls[1]?.body.text === "segunda bolha");
    check("splitter: ok total=2 sent=2", r.ok && r.total === 2 && r.sent === 2);
    check("splitter: 2 ids", r.ids.length === 2 && r.ids[0] === "MID_0" && r.ids[1] === "MID_1");
  }

  // -------------------------------------------------------------------------
  // 5. Erro HTTP — para na 1ª bolha que falha, ok=false
  // -------------------------------------------------------------------------
  reset(() => new Response("forbidden: bad apikey", { status: 401, statusText: "Unauthorized" }));
  {
    const r = await sendStevoText({ serverUrl: BASE, apiKey: "errado", number: "17867717077", text: "a\n---\nb" });
    check("erro http: ok=false", r.ok === false);
    check("erro http: sent=0", r.sent === 0);
    check("erro http: error contém 401", /401/.test(r.error || ""), r.error);
    check("erro http: para na 1ª (não tenta a 2ª)", calls.length === 1, `got=${calls.length}`);
  }

  // -------------------------------------------------------------------------
  // 6. Params inválidos — NÃO chama fetch
  // -------------------------------------------------------------------------
  reset();
  {
    const r1 = await sendStevoText({ serverUrl: "", apiKey: KEY, number: "17867717077", text: "x" });
    const r2 = await sendStevoText({ serverUrl: BASE, apiKey: "", number: "17867717077", text: "x" });
    const r3 = await sendStevoText({ serverUrl: BASE, apiKey: KEY, number: "", text: "x" });
    const r4 = await sendStevoText({ serverUrl: BASE, apiKey: KEY, number: "17867717077", text: "   " });
    check("inválido: serverUrl vazio → ok=false", r1.ok === false);
    check("inválido: apiKey vazio → ok=false", r2.ok === false);
    check("inválido: number vazio → ok=false", r3.ok === false);
    check("inválido: texto vazio → ok=false", r4.ok === false);
    check("inválido: nenhum fetch chamado", calls.length === 0, `got=${calls.length}`);
  }

  // -------------------------------------------------------------------------
  // 7. Sucesso sem JSON no corpo — ainda conta como enviado (sem id)
  // -------------------------------------------------------------------------
  reset(() => new Response("OK", { status: 200 }));
  {
    const r = await sendStevoText({ serverUrl: BASE, apiKey: KEY, number: "17867717077", text: "x" });
    check("sucesso não-json: ok", r.ok && r.sent === 1);
    check("sucesso não-json: ids vazio", r.ids.length === 0);
  }

  // -------------------------------------------------------------------------
  // 8. BOTÃO — payload + mapeamento + cap 3 + truncagem
  // -------------------------------------------------------------------------
  reset(() => new Response(JSON.stringify({ data: { Info: { ID: "MID_BTN" } } }), { status: 200 }));
  {
    const r = await sendStevoButton({
      serverUrl: BASE,
      apiKey: KEY,
      number: "+17867717077",
      title: "Confirmação",
      body: "Vou criar a nota. Confirma?",
      footer: "SparkBot",
      buttons: [
        { id: "confirm", label: "Confirmar ✅" },
        { id: "cancel", label: "Cancelar ❌" },
        { id: "x3", label: "Terceiro" },
        { id: "x4", label: "Quarto (descartado)" },
      ],
    });
    check("botão: ok", r.ok && r.sent === 1, JSON.stringify(r));
    check("botão: URL /send/button", calls[0]?.url === `${BASE}/send/button`, calls[0]?.url);
    check("botão: header apikey", calls[0]?.headers["apikey"] === KEY);
    check("botão: body.number normalizado", calls[0]?.body.number === "17867717077");
    check("botão: body.description = body", calls[0]?.body.description === "Vou criar a nota. Confirma?");
    const btns = (calls[0]?.body.buttons as Array<Record<string, unknown>>) || [];
    check("botão: cap 3 botões", btns.length === 3, `len=${btns.length}`);
    check("botão: type=reply", btns[0]?.type === "reply");
    check("botão: displayText + id mapeados", btns[0]?.displayText === "Confirmar ✅" && btns[0]?.id === "confirm");
    check("botão: id extraído (data.Info.ID)", r.ids[0] === "MID_BTN", JSON.stringify(r.ids));
  }

  // truncagem de label > 20
  reset(() => new Response(JSON.stringify({ id: "X" }), { status: 200 }));
  {
    await sendStevoButton({
      serverUrl: BASE, apiKey: KEY, number: "17867717077", body: "b",
      buttons: [{ id: "a", label: "Esse label é absurdamente longo demais" }],
    });
    const label = ((calls[0]?.body.buttons as Array<Record<string, unknown>>) || [])[0]?.displayText as string;
    check("botão: label truncado <=20", label.length <= 20, `len=${label.length} "${label}"`);
  }

  // -------------------------------------------------------------------------
  // 9. LISTA — payload + cap 10 rows + buttonText
  // -------------------------------------------------------------------------
  reset(() => new Response(JSON.stringify({ data: { Info: { ID: "MID_LIST" } } }), { status: 200 }));
  {
    const manyRows = Array.from({ length: 14 }, (_, i) => ({ rowId: `r${i}`, title: `Item ${i}` }));
    const r = await sendStevoList({
      serverUrl: BASE,
      apiKey: KEY,
      number: "17867717077",
      title: "Escolha",
      body: "Qual contato?",
      footer: "SparkBot",
      buttonText: "Ver opções",
      sections: [{ title: "Contatos", rows: manyRows }],
    });
    check("lista: ok", r.ok && r.sent === 1, JSON.stringify(r));
    check("lista: URL /send/list", calls[0]?.url === `${BASE}/send/list`);
    check("lista: buttonText", calls[0]?.body.buttonText === "Ver opções");
    check("lista: body.description", calls[0]?.body.description === "Qual contato?");
    check("lista: footerText", calls[0]?.body.footerText === "SparkBot");
    const secs = (calls[0]?.body.sections as Array<Record<string, unknown>>) || [];
    const rows = (secs[0]?.rows as unknown[]) || [];
    check("lista: cap 10 rows", rows.length === 10, `len=${rows.length}`);
    check("lista: id extraído", r.ids[0] === "MID_LIST");
  }

  // -------------------------------------------------------------------------
  // 10. Interativo — params inválidos NÃO chamam fetch
  // -------------------------------------------------------------------------
  reset();
  {
    const b1 = await sendStevoButton({ serverUrl: BASE, apiKey: KEY, number: "1786", body: "x", buttons: [] });
    const l1 = await sendStevoList({ serverUrl: BASE, apiKey: KEY, number: "1786", body: "x", buttonText: "v", sections: [] });
    check("botão: 0 botões → ok=false", b1.ok === false);
    check("lista: 0 rows → ok=false", l1.ok === false);
    check("interativo inválido: nenhum fetch", calls.length === 0, `got=${calls.length}`);
  }

  // -------------------------------------------------------------------------
  console.log(`\n${pass}/${total} PASS`);
  global.fetch = realFetch;
  process.exit(pass === total ? 0 : 1);
}

run();
