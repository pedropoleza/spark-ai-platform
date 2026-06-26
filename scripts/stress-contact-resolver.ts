/**
 * Stress test do motor de resolução de contato (H45, Pedro 2026-06-26).
 * (1) Unit: primitivas de normalização/score (deburr, nameScore, phoneSuffixScore) — sem rede.
 * (2) Live: resolveContact contra a CRM REAL (location da Sabrina) com os casos que falharam
 *     em prod — caso âncora Fernanda Lira (cadastrada com typo "fernanada"), telefone em vários
 *     formatos, e queries genéricas. NÃO precisa de ANTHROPIC_API_KEY (só GHL).
 * (3) Render do bloco "CONTATO EM CONTEXTO".
 *
 * Uso: npx tsx scripts/stress-contact-resolver.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";
import {
  deburr, nameScore, dice, phoneSuffixScore, looksLikePhone,
  resolveContact, getActiveContactContext, renderContactInFocusBlock, readRecentContacts,
} from "../src/lib/account-assistant/contact-resolver";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "K9b92VcD0KdCMIn60y0W"; // location ativa da rep Sabrina (caso Fernanda)
const FERNANDA_ID = "58OGJEO8yPtucmBXjZoq"; // "fernanada lira" (typo no cadastro)

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  " + detail : ""}`); }
}

function unit() {
  console.log("\n## UNIT — normalização & score (sem rede)");
  // deburr / acento
  ok("deburr Bárbara=barbara", deburr("Bárbara") === "barbara");
  ok("deburr João=joao", deburr("João") === "joao");
  ok("deburr Conceição=conceicao", deburr("Conceição") === "conceicao");
  // dice typo
  ok("dice fernanda~fernanada ≥0.8", dice("fernanda", "fernanada") >= 0.8, `(${dice("fernanda","fernanada").toFixed(2)})`);
  // nameScore — caso âncora
  const s1 = nameScore("Fernanda Lira", "fernanada lira");
  ok("nameScore 'Fernanda Lira'~'fernanada lira' ≥0.85", s1 >= 0.85, `(${s1.toFixed(2)})`);
  const s2 = nameScore("Fernanda Lira", "fernanda fernanda");
  ok("nameScore vs 'fernanda fernanda' < âncora", s2 < s1, `(${s2.toFixed(2)} < ${s1.toFixed(2)})`);
  // acento no score
  ok("nameScore 'Barbara'~'Bárbara' = 1", nameScore("Barbara", "Bárbara") >= 0.99);
  // ordem trocada
  ok("nameScore tolera ordem (Lira Fernanda)", nameScore("Lira Fernanda", "fernanada lira") >= 0.85);
  // telefone
  ok("phoneSuffix '+1 732 978 2721'~'7329782721'=1", phoneSuffixScore("+1 732 978 2721", "7329782721") === 1);
  ok("phoneSuffix '(732) 978-2721'~'+17329782721'=1", phoneSuffixScore("(732) 978-2721", "+17329782721") === 1);
  ok("phoneSuffix números diferentes = 0", phoneSuffixScore("5511999990000", "5511888881111") === 0);
  ok("looksLikePhone('7329782721')", looksLikePhone("7329782721"));
  ok("looksLikePhone('Fernanda Lira') = false", !looksLikePhone("Fernanda Lira"));
  // F10 read buffer (roundtrip + edge)
  ok("readRecentContacts roundtrip", JSON.stringify(readRecentContacts({ recent_contacts: [{ id: "a", name: "X" }] })) === JSON.stringify([{ id: "a", name: "X" }]));
  ok("readRecentContacts vazio/null = []", readRecentContacts({}).length === 0 && readRecentContacts(null).length === 0);
  ok("readRecentContacts ignora entradas sem id", readRecentContacts({ recent_contacts: [{ name: "semid" }, { id: "b" }] }).length === 1);
}

async function live() {
  console.log("\n## LIVE — resolveContact contra a CRM real (caso Fernanda)");
  const client = new GHLClient(COMPANY, LOC);

  // 1. Caso âncora: o que o bot fez ("Fernanda Lira") — antes voltava 0, agora deve achar.
  const r1 = await resolveContact(client, LOC, "Fernanda Lira", { defaultCountry: "US" });
  ok("'Fernanda Lira' acha a contato (era 0 antes)", !!r1.best, `best=${r1.best?.name} score=${r1.score} conf-gap=${r1.gap}`);
  ok("'Fernanda Lira' → id da fernanada lira", r1.best?.id === FERNANDA_ID, `id=${r1.best?.id}`);
  ok("'Fernanda Lira' score ≥ 0.85", r1.score >= 0.85, `(${r1.score})`);

  // 2. O typo exato.
  const r2 = await resolveContact(client, LOC, "fernanada", { defaultCountry: "US" });
  ok("'fernanada' (typo real) acha", r2.best?.id === FERNANDA_ID, `best=${r2.best?.name}`);

  // 3. Telefone em formatos variados → o resolver acha o DONO real do número por match
  // exato de sufixo (score 1, method phone), independente do formato digitado. (O número
  // 732-978-2721 é de uma contato "fernanda" wEJj…, não da "fernanada lira" — o resolver
  // acerta o dono real; o que importa é que a busca por telefone deixou de falhar.)
  let phoneOwnerId: string | null = null;
  for (const ph of ["+1 732 978 2721", "7329782721", "(732) 978-2721"]) {
    const rp = await resolveContact(client, LOC, ph, { defaultCountry: "US" });
    const good = !!rp.best && rp.score >= 0.9 && rp.method === "phone";
    ok(`telefone '${ph}' acha o dono (match exato)`, good, `best=${rp.best?.name} score=${rp.score} method=${rp.method}`);
    if (rp.best) phoneOwnerId = phoneOwnerId || rp.best.id;
    else continue;
    ok(`telefone '${ph}' → mesmo contato (formato-invariante)`, rp.best.id === phoneOwnerId, `id=${rp.best.id}`);
  }

  // 4. Invariante anti-review (sole NÃO fabrica gap): com 1 só candidato, gap===0.
  for (const q of ["Fernanda Lira", "Maria", "João", "Pedro", "7329782721"]) {
    const rq = await resolveContact(client, LOC, q, { defaultCountry: "US" });
    const inv = !(rq.sole && rq.gap !== 0) && !(rq.alternatives.length === 1 && rq.gap !== 0);
    ok(`invariante '${q}': sole/1-candidato ⇒ gap=0`, inv, `sole=${rq.sole} gap=${rq.gap} n=${rq.alternatives.length}`);
    console.log(`     ℹ️  best=${rq.best?.name || "—"} score=${rq.score} gap=${rq.gap} sole=${rq.sole} n=${rq.alternatives.length}`);
  }
}

function renderTest() {
  console.log("\n## RENDER — bloco CONTATO EM CONTEXTO");
  const block = renderContactInFocusBlock({
    focus: { id: FERNANDA_ID, name: "Fernanda Lira", source: "proactive", when: new Date().toISOString() },
    recent: [{ id: "abc123", name: "João Silva" }],
  });
  ok("bloco tem o id da pista", block.includes(FERNANDA_ID));
  ok("bloco diz PISTA/valide (anti-alucinação)", /PISTA|valide/i.test(block));
  ok("bloco tem o nome", block.includes("Fernanda Lira"));
  console.log("  ---\n" + block.split("\n").map((l) => "  | " + l).join("\n") + "\n  ---");
  // vazio quando não há contexto
  ok("sem contexto → bloco vazio", renderContactInFocusBlock({ focus: null, recent: [] }) === "");
  // foco SEM nome → não crava o contato, manda buscar+confirmar o nome (review low #2)
  const noName = renderContactInFocusBlock({ focus: { id: "xyz789", source: "tool_result" }, recent: [] });
  ok("foco sem nome → NÃO assume (manda confirmar nome)", /NÃO assuma|descobrir o nome|confirme/i.test(noName) && !/PROVAVELMENTE esse/.test(noName));
  void getActiveContactContext; // (testado em prod; aqui só garante o import/typecheck)
}

async function main() {
  unit();
  try { await live(); } catch (e) { fail++; console.log("  ❌ LIVE crashou:", e instanceof Error ? e.message : e); }
  renderTest();
  console.log(`\n==== RESULTADO: ${pass}/${pass + fail} OK ${fail ? `(${fail} FALHA)` : "✅"} ====`);
  process.exit(fail ? 1 : 0);
}
main();
