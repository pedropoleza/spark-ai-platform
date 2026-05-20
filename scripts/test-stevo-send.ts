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
import { sendStevoText, normalizeStevoNumber } from "@/lib/account-assistant/webhook/stevo-send";

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
  console.log(`\n${pass}/${total} PASS`);
  global.fetch = realFetch;
  process.exit(pass === total ? 0 : 1);
}

run();
