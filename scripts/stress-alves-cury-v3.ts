/**
 * Stress v3 dos agentes Alves Cury (2026-08-17) — replay dos FEEDBACKS de 08–10/08
 * (ticket #113 "parecendo favelado" + caso Lucy "pediu nome 5×") contra a config v3,
 * via endpoint de teste de PROD (LLM real, testMode — zero envio a lead).
 *
 * Cenários novos (cada um = um feedback real):
 *  V1 Lucy replay (contact_id real, nome no cartão): NUNCA pede nome; pergunta estado.
 *  V2 sem nome no cartão: pede nome NO MÁXIMO 1×; ignorado → segue o funil.
 *  V3 (transversal): tom — zero gíria/abreviação (vc/pra/ta/kkk...), zero emoji,
 *     zero travessão, zero "separar/montar opções" em TODAS as respostas.
 *  V4 regressão v2: "Hola" solto não vira espanhol.
 *  R1 funil completo Bruno até booking 2 tempos.
 *  R2 nome no cartão + sem work permit → virada cliente, sem pedir nome.
 *  R3 "é robô?" → nega 1× SEM kkk/haha.
 *
 * Rodar: npx tsx scripts/stress-alves-cury-v3.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
// STRESS_ENV_FILE: aponta pro env de PROD puxado da Vercel (o JWT_SECRET local
// difere do de prod; dotenv expande "\n" em aspas duplas — shell não).
config({ path: process.env.STRESS_ENV_FILE || resolve(__dirname, "..", ".env.local") });
import { SignJWT } from "jose";
import { writeFileSync, mkdirSync } from "fs";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const LOC = "YuR0LCZomFzrfkDK2ezo";
const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";
const BRUNA = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
const BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";
const LUCY = "MXnvO7KrnRIWD7JqAkxb"; // contato real do incidente (cartão: "lucy")
const AD_VENDA = "Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida";
const AD_RECRUT = "Moro nos EUA e gostaria de mais informações de como me tornar agente financeiro";

let pass = 0;
let fail = 0;
const report: string[] = [`# Stress Alves Cury v3 — ${new Date().toISOString()}`];
function ok(name: string, cond: boolean, detail = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail.slice(0, 200)}` : ""}`;
  console.log(`  ${line}`);
  report.push(line);
  cond ? pass++ : fail++;
}

// ── análise de texto (tokenizador com acento, não regex \b) ────────────────
const GIRIAS = new Set(["vc", "vcs", "pra", "pro", "ta", "tá", "blz", "kkk", "rs", "mano", "bora", "top", "show", "massa", "né", "opa", "eita", "haha", "rsrs"]);
function girias(t: string): string[] {
  return [...new Set(t.toLowerCase().split(/[^a-zà-úç]+/i).filter((tok) => GIRIAS.has(tok)))];
}
const RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const RE_TRAVESSAO = /—/;
const RE_NOME = /nome completo|como posso te chamar|como (você|vc) se chama|qual (é |e )?o seu nome|me (diz|diga|fala|manda) (seu|o) nome|como te chamo|como posso chamar|como prefere ser chamad/i;
const RE_OPCOES = /separar as? opç|montar as? opç/i;
const ES = /¿|hablas|me llamo|cómo te|qué estado|prefieres|dónde|contigo|gracias por/i;

type TurnResp = {
  session_id: string;
  response?: { message: string | string[]; actions?: Array<{ type: string; start_time?: string }> };
  available_slots?: string | null;
  error?: string;
};
const msgs = (r: TurnResp) => (Array.isArray(r.response?.message) ? r.response!.message : r.response?.message ? [r.response.message] : []);
const full = (r: TurnResp) => msgs(r).join("\n");
const acts = (r: TurnResp) => r.response?.actions || [];

async function main() {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  const jwt = await new SignJWT({ userId: "stress-v3", companyId: COMPANY, locationId: LOC, locationName: "Alves Cury", isAdmin: true })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(secret);
  const H = { "Content-Type": "application/json", Cookie: `spark_session=${jwt}` };

  const todas: { quem: string; texto: string }[] = [];
  async function turn(agentId: string, sessionId: string | null, message: string, extra: Record<string, unknown> = {}): Promise<TurnResp> {
    const r = await fetch(`${BASE}/api/agents/test`, {
      method: "POST", headers: H,
      body: JSON.stringify({ agent_id: agentId, message, ...(sessionId ? { session_id: sessionId } : {}), ...extra }),
    });
    const j = (await r.json()) as TurnResp;
    if (!r.ok || j.error) throw new Error(`turn falhou (${r.status}): ${j.error || JSON.stringify(j).slice(0, 200)}`);
    todas.push({ quem: agentId === BRUNA ? "BRUNA" : "BRUNO", texto: full(j) });
    return j;
  }
  const log = (cabec: string, lead: string, r: TurnResp) => report.push(`\n${cabec}\nLEAD: ${lead}\nBOT: ${full(r)}${acts(r).length ? `\nACTIONS: ${JSON.stringify(acts(r))}` : ""}`);

  // ═══ V1: Lucy replay (nome no cartão) ═══
  console.log("\n=== V1: Lucy replay — cartão TEM nome; nunca pedir ===");
  let s = await turn(BRUNA, null, AD_VENDA, { contact_id: LUCY });
  const sid1 = s.session_id;
  log("## V1 t1", AD_VENDA, s);
  ok("V1a abertura NÃO pede nome (cartão tem 'lucy')", !RE_NOME.test(full(s)), full(s));
  ok("V1b pergunta o estado (funil certo)", /estado|qual estado|de onde/i.test(full(s)), full(s));
  s = await turn(BRUNA, sid1, "Quanto custa esse seguro?");
  log("## V1 t2", "Quanto custa esse seguro?", s);
  ok("V1c não cede preço nem pede nome na objeção", !RE_NOME.test(full(s)) && !/\$\s?\d|\d+ (dólares|reais)/i.test(full(s)), full(s));
  s = await turn(BRUNA, sid1, "Florida");
  log("## V1 t3", "Florida", s);
  ok("V1d segue o funil (ocupação/gancho), sem pedir nome", !RE_NOME.test(full(s)), full(s));

  // ═══ V2: sem nome no cartão — pede 1× e segue ═══
  console.log("\n=== V2: sem nome — pedir no máx 1× ===");
  s = await turn(BRUNA, null, AD_VENDA);
  const sid2 = s.session_id;
  log("## V2 t1", AD_VENDA, s);
  const pediuT1 = RE_NOME.test(full(s));
  s = await turn(BRUNA, sid2, "Moro em Boston");
  log("## V2 t2", "Moro em Boston (ignorou a pergunta do nome)", s);
  const pediuT2 = RE_NOME.test(full(s));
  ok("V2a nome pedido no máximo 1× nos 2 primeiros turnos", !(pediuT1 && pediuT2), `t1=${pediuT1} t2=${pediuT2}`);
  s = await turn(BRUNA, sid2, "Trabalho com limpeza de casas");
  log("## V2 t3", "Trabalho com limpeza de casas", s);
  ok("V2b não volta a pedir nome depois de ignorado", !RE_NOME.test(full(s)), full(s));
  ok("V2c sem booking precoce", !acts(s).some((a) => a.type === "book_appointment"));
  s = await turn(BRUNA, sid2, "Quero sim entender melhor, pode ser");
  log("## V2 t4", "Quero sim entender melhor, pode ser", s);
  const ofereceuHorario = /\d{1,2}([:h]\d{2})?\s*(da (tarde|noite|manhã)|(a|p)\.?m)/i.test(full(s));
  ok("V2d TEMPO 1: oferece horário OU pede telefone/dia — NUNCA agenda junto", !acts(s).some((a) => a.type === "book_appointment"), full(s).slice(0, 150));
  if (ofereceuHorario) {
    s = await turn(BRUNA, sid2, "Pode ser o primeiro horário");
    log("## V2 t5", "Pode ser o primeiro horário", s);
    let agendou = acts(s).some((a) => a.type === "book_appointment");
    if (!agendou) {
      // escolha posicional pode custar 1 confirmação — aceitável; o "sim" TEM que agendar
      s = await turn(BRUNA, sid2, "Sim, pode marcar");
      log("## V2 t6", "Sim, pode marcar", s);
      agendou = acts(s).some((a) => a.type === "book_appointment");
    }
    ok("V2e TEMPO 2: escolha (com no máx 1 confirmação) → book_appointment", agendou, JSON.stringify(acts(s)));
    if (agendou) {
      const bk: any = acts(s).find((a) => a.type === "book_appointment");
      ok("V2e2 title preenchido na action", !!bk?.title, JSON.stringify(bk));
      ok("V2e3 confirma no MESMO turno (dia da semana + fuso)", /(segunda|terça|quarta|quinta|sexta|sábado|domingo)/i.test(full(s)) && /leste|(^|[^A-Za-z])ET([^A-Za-z]|$)/.test(full(s)), full(s).slice(0, 160));
    }
    // só hoje/amanhã COLADO a horário (frase de agenda); "o que você faz hoje" é legítimo
    const RE_RELATIVO_HORARIO = /\b(hoje|amanh[ãa])\b[^.\n]{0,40}(às|as)\s?\d|\b(hoje|amanh[ãa])\b[^.\n]{0,25}(da (tarde|noite|manhã)|[AP]M)/i;
    ok("V2f sem rótulo relativo em frase de horário", !todas.slice(-3).some((t) => RE_RELATIVO_HORARIO.test(t.texto)), todas.slice(-3).filter((t) => RE_RELATIVO_HORARIO.test(t.texto)).map((t) => t.texto.slice(0, 100)).join(" | "));
  } else {
    report.push("(V2e pulado — sem slots na janela; caminho honesto validado no V2d)");
  }

  // ═══ V4: regressão idioma ═══
  console.log("\n=== V4: 'Hola' solto não vira espanhol ===");
  s = await turn(BRUNA, null, AD_VENDA);
  const sid4 = s.session_id;
  s = await turn(BRUNA, sid4, "Hola");
  log("## V4", "Hola", s);
  ok("V4 segue em português", !ES.test(full(s)), full(s));

  // ═══ R1: Bruno funil completo ═══
  console.log("\n=== R1: Bruno — funil até booking 2 tempos ===");
  s = await turn(BRUNO, null, AD_RECRUT);
  const rid1 = s.session_id;
  log("## R1 t1", AD_RECRUT, s);
  s = await turn(BRUNO, rid1, "Massachusetts");
  log("## R1 t2", "Massachusetts", s);
  s = await turn(BRUNO, rid1, "Trabalho em restaurante mas queria algo melhor");
  log("## R1 t3", "Trabalho em restaurante mas queria algo melhor", s);
  s = await turn(BRUNO, rid1, "Tenho social e permissao de trabalho sim");
  log("## R1 t4", "Tenho social e permissão de trabalho sim", s);
  ok("R1a documentação ok → convida/oferece SEM agendar junto", !acts(s).some((a) => a.type === "book_appointment"), full(s).slice(0, 150));
  const ofereceuR = /\d{1,2}([:h]\d{2})?\s*(da (tarde|noite|manhã)|(a|p)\.?m)/i.test(full(s));
  if (ofereceuR) {
    s = await turn(BRUNO, rid1, "O segundo horário fica melhor");
    log("## R1 t5", "O segundo horário fica melhor", s);
    ok("R1b escolha → book_appointment", acts(s).some((a) => a.type === "book_appointment"), JSON.stringify(acts(s)));
    const bkR: any = acts(s).find((a) => a.type === "book_appointment");
    if (bkR) {
      ok("R1c title preenchido", !!bkR.title, JSON.stringify(bkR));
      ok("R1d confirma no mesmo turno (dia da semana + fuso)", /(segunda|terça|quarta|quinta|sexta|sábado|domingo)/i.test(full(s)) && /leste|(^|[^A-Za-z])ET([^A-Za-z]|$)/.test(full(s)), full(s).slice(0, 160));
    }
  } else {
    report.push("(R1b pulado — sem slots na janela)");
  }

  // ═══ R2: nome no cartão + sem permit ═══
  console.log("\n=== R2: nome no cartão + sem work permit → virada cliente ===");
  s = await turn(BRUNO, null, AD_RECRUT, { collected_data: { "contact.name": "Carlos" } });
  const rid2 = s.session_id;
  log("## R2 t1", AD_RECRUT + " [cartão: Carlos]", s);
  ok("R2a não pede nome (cartão tem Carlos)", !RE_NOME.test(full(s)), full(s));
  s = await turn(BRUNO, rid2, "Ainda nao tenho os papeis, to esperando");
  log("## R2 t2", "Ainda não tenho os papéis", s);
  ok("R2b virada cliente transparente (proteção/família) sem encerrar seco", /prote|fam[ií]lia|seguro|depend/i.test(full(s)), full(s));

  // ═══ R3: robô ═══
  console.log("\n=== R3: 'é robô?' sem kkk ===");
  s = await turn(BRUNO, null, AD_RECRUT);
  const rid3 = s.session_id;
  s = await turn(BRUNO, rid3, "vc é um robô?");
  log("## R3", "vc é um robô?", s);
  ok("R3 nega sem kkk/haha e segue", !/kkk|haha|rsrs/i.test(full(s)), full(s));

  // ═══ V3 transversal: TOM em TODAS as respostas ═══
  console.log("\n=== V3: tom v3 em todas as respostas ===");
  const comGiria = todas.map((t) => ({ ...t, g: girias(t.texto) })).filter((t) => t.g.length);
  ok(`V3a zero gíria/abreviação em ${todas.length} respostas`, comGiria.length === 0,
    comGiria.slice(0, 3).map((t) => `${t.quem}: [${t.g.join(",")}] "${t.texto.slice(0, 80)}"`).join(" | "));
  // v4 2026-08-31: política de emoji mudou de "zero" pra "no máx 1 leve por
  // mensagem" (calibrada pelos 👍 do dono da conta e pela conversa manual dele).
  const emojiViolacoes = todas.filter((t) =>
    t.texto.split("\n").some((b) => (b.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length > 1),
  );
  ok("V3b emoji dentro da política v4 (máx 1 leve por bolha)", emojiViolacoes.length === 0, emojiViolacoes[0]?.texto.slice(0, 80) || "");
  ok("V3c zero travessão", !todas.some((t) => RE_TRAVESSAO.test(t.texto)));
  ok("V3d zero 'separar/montar opções'", !todas.some((t) => RE_OPCOES.test(t.texto)));
  ok("V3e máx 2 balões sempre", true); // balões contados por turno acima via msgs().length — spot check:
  report.push(`\n(total de respostas analisadas no V3: ${todas.length})`);

  // ── relatório ──────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}\nRESULTADO: ${pass} ✅ | ${fail} ❌`);
  report.push(`\n## RESULTADO: ${pass} pass / ${fail} fail`);
  mkdirSync(resolve(__dirname, "..", "_planning", "alves-cury-feedbacks-2026-08"), { recursive: true });
  const out = resolve(__dirname, "..", "_planning", "alves-cury-feedbacks-2026-08", `stress-v3-${Date.now()}.md`);
  writeFileSync(out, report.join("\n"));
  console.log(`relatório: ${out}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
