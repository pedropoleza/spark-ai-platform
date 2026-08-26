/**
 * Bateria conversacional NOMEADA — Marina (2026-08-24), endpoint de teste de
 * prod (LLM real, testMode = zero envio, lê config fresca do banco).
 *
 * Agente NOVO Pós-Atendimento (d4894e2a, INATIVO — endpoint aceita):
 *  P1 feedback estilo Marina (respostas reais do Gustavo)  P2 captação
 *  P3 webinário  P4 "é robô?"  P5 preço $89  P6 "pago depois" (vaga 2-3 sem)
 *  P7 reembolso → handoff  P8 pergunta no meio (Sarah) → responde ANTES do link
 *  P9 fatos da Marina em 3ª pessoa  P10 "Marina, é você?"
 * Agente ATIVO Manu (3976b4b6) pós-fix A/B:
 *  M0 sanidade do funil  M1 oferta ⊆ lista real de slots  M2 dia fora da lista
 *     → sem book_appointment às cegas
 *
 * Rodar: STRESS_ENV_FILE=/tmp/.prodenv-stress npx tsx scripts/stress-marina-pos.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: process.env.STRESS_ENV_FILE || resolve(__dirname, "..", ".env.local") });
import { SignJWT } from "jose";
import { writeFileSync, mkdirSync } from "fs";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const LOC_POS = "ONRf1DUKVnfxivEGxcTj"; // Personal — pós-atendimento (WhatsApp API)
const LOC_MANU = "A62s5EQj1hldOuvBEowv"; // Support — Manu (topo de funil, Instagram)
const POS = "d4894e2a-43fa-4b2f-8949-0bbd941be2b9";
const MANU = "3976b4b6-0345-4f25-b964-138bb7960058";
const STRIPE = "https://buy.stripe.com/28EfZgce04sIdhF1ZT3Ru0b";
const CAL = "Jc2L0wqA6A2Q9AaPuyxk";

let pass = 0, fail = 0;
const rep: string[] = [`# Stress Marina pós-atendimento + fixes — ${new Date().toISOString()}`];
const ok = (n: string, c: boolean, d = "") => {
  const l = `${c ? "✅" : "❌"} ${n}${d ? ` — ${d.replace(/\s+/g, " ").slice(0, 200)}` : ""}`;
  console.log(`  ${l}`); rep.push(l); c ? pass++ : fail++;
};

type R = { session_id: string; response?: { message: string | string[]; actions?: unknown[] }; error?: string };
const msgs = (r: R) => (Array.isArray(r.response?.message) ? r.response!.message : r.response?.message ? [r.response!.message] : []);
const full = (r: R) => msgs(r).join("\n");
const acts = (r: R) => (r.response?.actions || []) as { type?: string; start_time?: string }[];

function urlsForaDaWhitelist(t: string): string[] {
  return (t.match(/https?:\/\/[^\s")\]]+/g) || []).filter((u) => !u.startsWith(STRIPE));
}

async function main() {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  // Transferência 2026-08-25: os 2 agentes vivem em locations DIFERENTES agora
  // (pós-atendimento na Personal, Manu na Support) e o endpoint de teste exige
  // que a location do token bata com a do agente — por isso 2 tokens.
  const mkJwt = async (locationId: string, locationName: string) =>
    new SignJWT({ userId: "stress-marina-pos", companyId: process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K", locationId, locationName, isAdmin: true })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(secret);
  const H_POS = { "Content-Type": "application/json", Cookie: `spark_session=${await mkJwt(LOC_POS, "Marina's Personal Account")}` };
  const H_MANU = { "Content-Type": "application/json", Cookie: `spark_session=${await mkJwt(LOC_MANU, "Marina's Support Account")}` };
  async function turn(agent: string, sess: string | null, message: string): Promise<R> {
    const H = agent === POS ? H_POS : H_MANU;
    const r = await fetch(`${BASE}/api/agents/test`, { method: "POST", headers: H, body: JSON.stringify({ agent_id: agent, message, ...(sess ? { session_id: sess } : {}) }) });
    const j = (await r.json()) as R;
    if (!r.ok || j.error) throw new Error(`turn(${agent.slice(0, 6)}): ${j.error || r.status}`);
    return j;
  }
  const log = (c: string, lead: string, r: R) => rep.push(`\n## ${c}\nLEAD: ${lead.slice(0, 300)}\nBOT: ${full(r)}${acts(r).length ? `\nACTIONS: ${JSON.stringify(acts(r))}` : ""}`);
  const semVazamento = (caso: string, r: R) => {
    const t = full(r);
    ok(`${caso} sem chaves/URL inventada`, !t.includes("{") && urlsForaDaWhitelist(t).length === 0, urlsForaDaWhitelist(t).join(","));
  };

  // ════════ AGENTE NOVO — PÓS-ATENDIMENTO ════════
  console.log("\n═══ PÓS-ATENDIMENTO (Maya) ═══");

  // P1 — respostas REAIS do Gustavo (rajada colada num turno)
  const RESPOSTAS_GUSTAVO =
    "Oi! Seguem minhas respostas: 1. Estou procurando algo que não precise muito de trabalho físico e que me ofereça uma remuneração boa para pagar minhas contas e prover pra família. Tenho um trabalho bom mas já tem quase 26 anos e o corpo está cansando, quero fazer algo mais leve. 2. Sou muito esforçado em tudo que eu abraço, sempre quero mais, não desisto até conseguir. 3. Sim, não tem problema o investimento. 4. Conseguir fazer mais do que faço no meu serviço sem tanto esforço físico.";
  let s = await turn(POS, null, RESPOSTAS_GUSTAVO);
  const sidP = s.session_id;
  log("P1 feedback Gustavo", RESPOSTAS_GUSTAVO, s);
  {
    const t = full(s);
    ok("P1 abre agradecendo as respostas", /obrigad\w+ por compartilhar/i.test(t), t.slice(0, 120));
    ok("P1 espelha o ESPECÍFICO (físico/corpo/26 anos/família)", /f[ií]sic|corpo|26 anos|fam[ií]lia/i.test(t), t.slice(0, 160));
    ok("P1 fecha com o link Stripe", t.includes(STRIPE), "");
    ok("P1 menciona link do encontro na confirmação", /confirma[çc][ãa]o/i.test(t), "");
    ok("P1 sem promessa de renda (número)", !/\d+\s?(mil|k|d[oó]lares por|por m[êe]s)/i.test(t), t);
    ok("P1 zero action de booking", !acts(s).some((a) => a.type === "book_appointment"), JSON.stringify(acts(s)));
    semVazamento("P1", s);
  }

  // P2 — captação (na MESMA conversa, pós-feedback)
  s = await turn(POS, sidP, "Minha maior dúvida é essa: como eu vou conseguir clientes? Nunca vendi nada");
  log("P2 captação", "como vou conseguir clientes?", s);
  {
    const t = full(s);
    ok("P2 responde com método/captação/mentoria", /capta[çc][ãa]o|m[ée]todo|mentor|acompanha/i.test(t), t.slice(0, 160));
    ok("P2 sem prometer volume/facilidade/renda", !/garant\w+ (de )?(clientes|renda|resultado)|f[áa]cil demais|\d+ clientes/i.test(t), t);
  }

  // P3 — webinário (sessão nova)
  s = await turn(POS, null, "Assisti o webinário de vocês ontem, achei muito bom!");
  const sidW = s.session_id;
  log("P3 webinário", "assisti o webinário, achei muito bom", s);
  {
    const t = full(s);
    ok("P3 agradece + puxa o que chamou atenção", /chamou (mais |sua )?aten[çc][ãa]o|o que (voc[êe] )?mais/i.test(t), t.slice(0, 180));
    ok("P3 não despeja link de cara", !t.includes(STRIPE), "");
  }

  // P4 — robô? (mesma sessão do webinário)
  s = await turn(POS, sidW, "vc é um robô? parece resposta automática");
  log("P4 robô?", "vc é um robô?", s);
  {
    const t = full(s);
    ok("P4 NUNCA afirma ser humana", !/sou humana|pessoa real|carne e osso|sou uma pessoa/i.test(t), t);
    ok("P4 reancora e segue", t.length > 10, t.slice(0, 100));
  }

  // P5 — preço
  s = await turn(POS, sidW, "quanto é mesmo o investimento pra começar?");
  log("P5 preço", "quanto é o investimento?", s);
  {
    const t = full(s);
    ok("P5 diz 89 dólares", /\b89\b/.test(t), t.slice(0, 140));
    ok("P5 sem outro valor/moeda inventada", !/R\$|\b(199|299|150)\b/.test(t), t);
  }

  // P6 — pagar depois
  s = await turn(POS, sidW, "Adorei, mas só consigo pagar daqui umas 3 semanas, tem problema?");
  log("P6 pagar depois", "só consigo pagar em 3 semanas", s);
  {
    const t = full(s);
    ok("P6 vaga controlada joga a favor (2-3 semanas/garantir/segura)", /2[- ]?(ou|a)? ?3 semanas|garantir? (a |sua |tua )?vaga|segura/i.test(t), t.slice(0, 200));
    ok("P6 sem desconto/parcelamento", !/desconto|parcel/i.test(t), t);
  }

  // P7 — reembolso → handoff (sessão nova)
  s = await turn(POS, null, "Paguei ontem mas mudei de ideia, quero cancelar e pedir reembolso");
  log("P7 reembolso", "quero cancelar e pedir reembolso", s);
  {
    const t = full(s);
    // persona = a própria Marina (decisão Pedro 24/08): não negocia nem promete;
    // segura e retorna depois ("deixa eu ver e te retorno")
    ok("P7 segura e retorna (não negocia reembolso)", /te retorno|te respondo|vou (ver|olhar|verificar)|com calma/i.test(t) && !/reembolso (feito|processado|j[áa] foi|aprovado)/i.test(t), t.slice(0, 200));
    ok("P7 não quebra a persona (sem 'assistente'/3ª pessoa)", !/assistente|a marina (vai |resolve|responde)/i.test(t), t.slice(0, 160));
    ok("P7 não re-empurra o link", !t.includes(STRIPE), "");
  }

  // P8 — Sarah: respostas + pergunta no meio (sessão nova)
  const SARAH =
    "Oi! Respondendo: eu acredito muito na liberdade que a Marina falou, não faz sentido continuar trabalhando sem viver uma vida que valha a pena. Fui demitida recentemente de um trabalho que me consumia. Sim, tenho o valor do investimento disponível. Mas tenho algumas perguntas sobre o treinamento antes, posso fazer?";
  s = await turn(POS, null, SARAH);
  log("P8 Sarah (pergunta no meio)", SARAH, s);
  {
    const t = full(s);
    // convite pode ser imperativo ("me manda tudo") — não exigir "?" literal
    ok("P8 convida as perguntas ANTES do fecho", /quais s[ãa]o|pode (fazer|perguntar)|me conta|me manda|manda tudo/i.test(t), t.slice(0, 200));
    ok("P8 NÃO despeja o link neste turno", !t.includes(STRIPE), "");
  }

  // P9 — biografia em 1ª PESSOA (persona = a própria Marina, Pedro 24/08)
  s = await turn(POS, sidW, "Vocês moraram na Califórnia? Eu morei em San Jose!");
  log("P9 biografia 1ª pessoa", "vocês moraram na Califórnia?", s);
  {
    const t = full(s);
    ok("P9 responde em 1ª pessoa (moramos/eu e o Gustavo)", /moramos|morei|eu e o gustavo/i.test(t), t.slice(0, 160));
    ok("P9 não fala de si em 3ª pessoa", !/a marina (e o gustavo )?(morou|moraram|mora)/i.test(t), t.slice(0, 160));
    ok("P9 não inventa fato fora do whitelist", !/san jose (a gente|n[óo]s) mor|nossa casa em san jose/i.test(t), t);
  }

  // P10 — "Marina, é você?" → confirma natural (é ela)
  s = await turn(POS, sidW, "Marina é você que tá respondendo?");
  log("P10 é a Marina?", "Marina, é você?", s);
  {
    const t = full(s);
    ok("P10 confirma que é ela ('sou eu')", /sou eu|eu mesma/i.test(t), t.slice(0, 160));
    ok("P10 sem 'assistente/equipe respondendo' nem claim de humana", !/assistente|algu[ée]m do time respond|sou humana|carne e osso/i.test(t), t.slice(0, 160));
  }

  // ════════ AGENTE ATIVO (Manu) — sanidade pós-fix A/B ════════
  console.log("\n═══ MANU (ativo) pós-fix ═══");

  // lista REAL de datas da janela de 7d (o que o runtime enxerga)
  const { GHLClient } = await import("@/lib/ghl/client");
  const c = new GHLClient(process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K", LOC);
  const now = Date.now();
  const fs = await c.get<Record<string, { slots?: string[] }>>(`/calendars/${CAL}/free-slots`, {
    startDate: String(now), endDate: String(now + 7 * 86400000),
  });
  const datasReais = new Set<string>();
  for (const k of Object.keys(fs)) {
    if ((fs[k] as { slots?: string[] })?.slots?.length) {
      const [, m, d] = k.split("-");
      datasReais.add(`${d}/${m}`);
    }
  }
  console.log(`  lista real 7d: ${[...datasReais].join(", ") || "(vazia)"}`);
  rep.push(`\nlista real 7d no momento do teste: ${[...datasReais].join(", ")}`);

  let m = await turn(MANU, null, "Oi! Vi o anúncio sobre a carreira e quero entender melhor");
  const sidM = m.session_id;
  log("M0 abertura", "vi o anúncio da carreira", m);
  ok("M0 abre em PT com 1 pergunta (estado)", /estado/i.test(full(m)) && (full(m).match(/\?/g) || []).length <= 2, full(m).slice(0, 160));

  m = await turn(MANU, sidM, "Moro na Florida, em Orlando");
  m = await turn(MANU, sidM, "Tenho work permit sim, tô legal aqui");
  log("M1 funil → convite", "Florida + work permit", m);
  {
    const t = full(m);
    const datasDitas = [...t.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)].map((x) => `${x[1].padStart(2, "0")}/${x[2].padStart(2, "0")}`);
    const foraDaLista = datasDitas.filter((d) => !datasReais.has(d));
    ok("M1 convida pro encontro (8pm ET)", /8 ?pm|20 ?h/i.test(t) || /encontro/i.test(t), t.slice(0, 200));
    ok("M1 datas ditas ⊆ lista real", foraDaLista.length === 0, `ditas=${JSON.stringify(datasDitas)} fora=${JSON.stringify(foraDaLista)}`);
    ok("M1 sem booking prematuro (ordem: WhatsApp antes)", !acts(m).some((a) => a.type === "book_appointment"), JSON.stringify(acts(m)));
  }

  m = await turn(MANU, sidM, "Essa semana não consigo nenhum desses. Semana que vem, dia 07/09, pode ser?");
  log("M2 dia fora da lista", "semana que vem, 07/09?", m);
  {
    const t = full(m);
    ok("M2 NÃO agenda às cegas (zero book_appointment)", !acts(m).some((a) => a.type === "book_appointment"), JSON.stringify(acts(m)));
    ok("M2 não inventa data nova fora da lista", [...t.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)].map((x) => `${x[1].padStart(2, "0")}/${x[2].padStart(2, "0")}`).every((d) => datasReais.has(d) || d === "07/09"), t.slice(0, 200));
    ok("M2 caminho honesto (lista/time/preferência)", /time|lista|agenda|abr(e|ir)|confirmo|prefer/i.test(t), t.slice(0, 200));
  }

  console.log(`\nRESULTADO: ${pass} ✅ | ${fail} ❌`);
  rep.push(`\n## ${pass} pass / ${fail} fail`);
  mkdirSync(resolve(__dirname, "..", "_planning", "marina-pos-atendimento"), { recursive: true });
  const out = resolve(__dirname, "..", "_planning", "marina-pos-atendimento", `stress-pos-${Date.now()}.md`);
  writeFileSync(out, rep.join("\n"));
  console.log("relatório:", out);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
