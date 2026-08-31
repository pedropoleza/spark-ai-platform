/**
 * Stress v4 Alves Cury (2026-08-31) — replay dos defeitos do quase-churn de
 * 26-28/08 contra a config v4 + guards H88, via endpoint de teste de PROD
 * (LLM real, testMode — zero envio a lead).
 *
 * Cenários (cada um = um defeito real da janela):
 *  N1 caso Andréia: lead de anúncio de RECRUTAMENTO cai na BRUNA → ela NÃO
 *     pode negar a frente ("não é recrutamento") — reconhece + handed_off.
 *  N2 espelho: lead de VENDA cai no BRUNO → não nega a frente de seguro.
 *  N3 caso Cleidmar: antes de oferecer horário, a ponte tem que dizer que é
 *     ZOOM com especialista e sem compromisso (👎 real de 28/08).
 *  N4 meta-narração: frase inteira em espanhol → segue em espanhol SEM anunciar.
 *  N5 wrong number: "Wrong number, sorry" → responde EM INGLÊS, curto, encerra.
 *  N6 caso Andréia t2: "Renda extra é possível?" no Bruno → sem promessa de
 *     ganho/comissão/valor; conduz pra conversa.
 *  Transversais (todas as respostas de todos os cenários):
 *     zero gíria pesada · zero travessão · zero "separar/montar opções" ·
 *     zero justificativa instrumental ("assim consigo te passar...") ·
 *     zero "hoje/amanhã" colado em horário (day-guard já absolutiza no server) ·
 *     zero "posso te ligar" · emoji no máx 1/mensagem e só leve · ≤3 balhas.
 *
 * Rodar: STRESS_ENV_FILE=/tmp/.prodenv-stress npx tsx scripts/stress-alves-cury-v4.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: process.env.STRESS_ENV_FILE || resolve(__dirname, "..", ".env.local") });
import { SignJWT } from "jose";
import { writeFileSync, mkdirSync } from "fs";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const LOC = "YuR0LCZomFzrfkDK2ezo";
const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";
const BRUNA = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
const BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";
const AD_VENDA = "Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida";
const AD_RECRUT =
  "*Headline:* Oportunidade para brasileiros nos EUA\n*Source URL:* https://www.instagram.com/p/DbrULUiAcW0/\n\nMoro nos EUA e gostaria de mais informações de como me tornar agente financeiro";

let pass = 0;
let fail = 0;
const report: string[] = [`# Stress Alves Cury v4 — ${new Date().toISOString()}`];
function ok(name: string, cond: boolean, detail = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail.slice(0, 220)}` : ""}`;
  console.log(`  ${line}`);
  report.push(line);
  cond ? pass++ : fail++;
}

const GIRIAS = new Set(["vc", "vcs", "pra", "pro", "ta", "blz", "kkk", "rs", "mano", "bora", "top", "show", "massa", "né", "haha", "rsrs"]);
function girias(t: string): string[] {
  return [...new Set(t.toLowerCase().split(/[^a-zà-úç]+/i).filter((tok) => GIRIAS.has(tok)))];
}
const RE_TRAVESSAO = /—/;
const RE_OPCOES = /separar as? opç|montar as? opç/i;
const RE_MOEDA = /assim (eu )?consigo te (passar|mandar|preparar)|com (isso|esse dado) (eu )?(consigo|avanço|posso avançar)|para eu (preparar|montar|separar)/i;
const RE_NEGA_RECRUT = /não é recrutamento|nao e recrutamento|não é oportunidade de emprego|não fazemos recrutamento|não trabalhamos com recrutamento/i;
const RE_NEGA_SEGURO = /não (vendemos|trabalhamos com|é) seguro|nao (vendemos|trabalhamos com|e) seguro/i;
const RE_HOJE_AMANHA_HORA = /\b(hoje|amanh[ãa])\b[^.!?\n]{0,40}\b(às?\s*\d|\d{1,2}\s*(da\s+(manhã|tarde|noite)|[ap]m|h\b))/iu;
const RE_LIGAR = /posso te ligar|te ligo|posso ligar para você|te chamo no telefone/i;
const RE_EMOJI_G = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const ES_RE = /¿|qué|cómo|dónde|estás|contigo|gracias|hablas/i;
const ANUNCIA_IDIOMA = /vou seguir (em|no) espanhol|voy a seguir|sigo en español|você mencionou que fala|mencionaste que hablas|então vou seguir assim/i;

type TurnResp = {
  session_id: string;
  response?: {
    message: string | string[];
    actions?: Array<{ type: string; start_time?: string }>;
    conversation_status?: string;
  };
  error?: string;
};
const msgs = (r: TurnResp) => (Array.isArray(r.response?.message) ? r.response!.message : r.response?.message ? [r.response.message] : []);
const full = (r: TurnResp) => msgs(r).join("\n");

async function main() {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  const jwt = await new SignJWT({ userId: "stress-v4", companyId: COMPANY, locationId: LOC, locationName: "Alves Cury", isAdmin: true })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(secret);
  const H = { "Content-Type": "application/json", Cookie: `spark_session=${jwt}` };

  const todas: { quem: string; texto: string; bolhas: number }[] = [];
  async function turn(agentId: string, sessionId: string | null, message: string, extra: Record<string, unknown> = {}): Promise<TurnResp> {
    const r = await fetch(`${BASE}/api/agents/test`, {
      method: "POST", headers: H,
      body: JSON.stringify({ agent_id: agentId, message, ...(sessionId ? { session_id: sessionId } : {}), ...extra }),
    });
    const j = (await r.json()) as TurnResp;
    if (!r.ok || j.error) throw new Error(`turn falhou (${r.status}): ${j.error || JSON.stringify(j).slice(0, 200)}`);
    todas.push({ quem: agentId === BRUNA ? "BRUNA" : "BRUNO", texto: full(j), bolhas: msgs(j).length });
    return j;
  }
  const log = (cabec: string, lead: string, r: TurnResp) =>
    report.push(`\n${cabec}\nLEAD: ${lead}\nBOT: ${full(r)}${r.response?.conversation_status ? `\nSTATUS: ${r.response.conversation_status}` : ""}`);

  // ═══ N1: caso Andréia — recrutamento na BRUNA ═══
  console.log("\n=== N1: lead de RECRUTAMENTO cai na BRUNA (caso Andréia) ===");
  let s = await turn(BRUNA, null, AD_RECRUT);
  log("## N1 t1", "(anúncio recrutamento)", s);
  ok("N1a NÃO nega a frente de recrutamento", !RE_NEGA_RECRUT.test(full(s)), full(s));
  ok("N1b reconhece a frente/time de carreira", /recrutamento|carreira|agente financeiro|time/i.test(full(s)), full(s).slice(0, 150));
  ok("N1c fecha handed_off (time avisado)", s.response?.conversation_status === "handed_off", `status=${s.response?.conversation_status}`);
  // t2: a pergunta REAL da Andréia
  const sidN1 = s.session_id;
  s = await turn(BRUNA, sidN1, "Renda extra é possível?");
  log("## N1 t2", "Renda extra é possível?", s);
  ok("N1d ainda sem negar nem prometer ganho", !RE_NEGA_RECRUT.test(full(s)) && !/\$\s?\d|ganha (até|uns)|comissão de/i.test(full(s)), full(s).slice(0, 150));

  // ═══ N2: espelho — venda no BRUNO ═══
  console.log("\n=== N2: lead de VENDA cai no BRUNO ===");
  s = await turn(BRUNO, null, AD_VENDA);
  log("## N2 t1", AD_VENDA, s);
  ok("N2a NÃO nega a frente de seguro", !RE_NEGA_SEGURO.test(full(s)), full(s));
  ok("N2b reconhece a frente de proteção/seguro", /seguro|proteção/i.test(full(s)), full(s).slice(0, 150));
  ok("N2c fecha handed_off", s.response?.conversation_status === "handed_off", `status=${s.response?.conversation_status}`);

  // ═══ N3: ponte-antes-de-horários (caso Cleidmar) ═══
  console.log("\n=== N3: ponte com Zoom+especialista ANTES dos horários ===");
  s = await turn(BRUNA, null, AD_VENDA);
  const sid3 = s.session_id;
  log("## N3 t1", AD_VENDA, s);
  s = await turn(BRUNA, sid3, "Flórida");
  log("## N3 t2", "Flórida", s);
  s = await turn(BRUNA, sid3, "Trabalho por conta própria, tenho uma empresa de limpeza");
  log("## N3 t3", "Conta própria (limpeza)", s);
  let conversa3 = todas.filter((t) => t.quem === "BRUNA").slice(-3).map((t) => t.texto).join("\n");
  let ofereceu = /\d{1,2}([:h]\d{2})?\s*(da (tarde|noite|manhã)|(a|p)\.?m)/i.test(full(s));
  if (!ofereceu) {
    s = await turn(BRUNA, sid3, "Pode ser sim, quero entender melhor");
    log("## N3 t4", "Pode ser sim, quero entender melhor", s);
    conversa3 += "\n" + full(s);
    ofereceu = /\d{1,2}([:h]\d{2})?\s*(da (tarde|noite|manhã)|(a|p)\.?m)/i.test(full(s));
  }
  if (ofereceu) {
    const ponteAntes = /zoom/i.test(conversa3) && /(especialista|Taciana|nossa equipe)/i.test(conversa3) && /(sem compromisso|30 min|meia hora|sem custo)/i.test(conversa3);
    ok("N3a horários só DEPOIS da ponte (Zoom + especialista + sem compromisso)", ponteAntes, conversa3.slice(-300));
  } else {
    ok("N3a (ainda qualificando — sem horário até aqui, ponte pendente)", true, full(s).slice(0, 120));
  }

  // ═══ N4: espanhol sem meta-narração ═══
  console.log("\n=== N4: espanhol sem anunciar a troca ===");
  s = await turn(BRUNA, null, "Hola, vivo en Estados Unidos y quiero información sobre el seguro de vida por favor");
  log("## N4 t1", "(frase inteira em espanhol)", s);
  ok("N4a responde em espanhol", ES_RE.test(full(s)), full(s).slice(0, 120));
  ok("N4b SEM meta-narração da troca de idioma", !ANUNCIA_IDIOMA.test(full(s)), full(s).slice(0, 150));

  // ═══ N5: wrong number em inglês ═══
  console.log("\n=== N5: wrong number ===");
  s = await turn(BRUNA, null, AD_VENDA);
  const sid5 = s.session_id;
  s = await turn(BRUNA, sid5, "Sorry, wrong number. I don't speak Portuguese.");
  log("## N5 t2", "Sorry, wrong number. I don't speak Portuguese.", s);
  const resp5 = full(s);
  ok("N5a responde EM INGLÊS", /sorry|apolog|no problem|have a (great|good)/i.test(resp5) && !/desculp|qualquer coisa|chamar/i.test(resp5), resp5);
  ok("N5b curto (≤200 chars)", resp5.length <= 200, `${resp5.length} chars`);

  // ═══ N6: "quanto custa a licença?" no Bruno ═══
  console.log("\n=== N6: custo de licença no Bruno ===");
  s = await turn(BRUNO, null, "*Headline:* Oportunidade para brasileiros nos EUA\n\nQuero saber mais sobre ser agente. Quanto custa pra tirar a licença?");
  log("## N6 t1", "Quanto custa pra tirar a licença?", s);
  ok("N6a não cita valor de licença/comissão", !/\$\s?\d|\d+ (dólares|reais)|custa (uns|cerca|aproximadamente)/i.test(full(s)), full(s).slice(0, 150));

  // ═══ Transversais ═══
  console.log("\n=== Transversais (todas as respostas) ===");
  const problemas: string[] = [];
  for (const t of todas) {
    const g = girias(t.texto);
    if (g.length) problemas.push(`gíria [${g.join(",")}]: "${t.texto.slice(0, 80)}"`);
    if (RE_TRAVESSAO.test(t.texto)) problemas.push(`travessão: "${t.texto.slice(0, 80)}"`);
    if (RE_OPCOES.test(t.texto)) problemas.push(`separar/montar opções: "${t.texto.slice(0, 80)}"`);
    if (RE_MOEDA.test(t.texto)) problemas.push(`moeda de troca: "${t.texto.slice(0, 80)}"`);
    if (RE_HOJE_AMANHA_HORA.test(t.texto)) problemas.push(`hoje/amanhã + hora: "${t.texto.slice(0, 100)}"`);
    if (RE_LIGAR.test(t.texto)) problemas.push(`"posso te ligar": "${t.texto.slice(0, 80)}"`);
    for (const bolha of t.texto.split("\n")) {
      const emojis = bolha.match(RE_EMOJI_G) || [];
      if (emojis.length > 1) problemas.push(`${emojis.length} emojis numa bolha: "${bolha.slice(0, 80)}"`);
    }
    if (t.bolhas > 3) problemas.push(`${t.bolhas} balões numa resposta`);
  }
  ok(`T1 zero violações transversais em ${todas.length} respostas`, problemas.length === 0, problemas.slice(0, 4).join(" | "));

  report.push(`\n## Resultado: ${pass} ✅ / ${fail} ❌`);
  mkdirSync(resolve(__dirname, "..", "_planning", "alves-cury-feedbacks-2026-08"), { recursive: true });
  const out = resolve(__dirname, "..", "_planning", "alves-cury-feedbacks-2026-08", `stress-v4-${Date.now()}.md`);
  writeFileSync(out, report.join("\n"));
  console.log(`\n${pass} ✅ / ${fail} ❌ — relatório: ${out}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("ERRO:", e?.message || e);
  process.exit(1);
});
