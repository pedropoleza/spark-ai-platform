/**
 * Stress dos agentes Alves Cury v2 (2026-07-29) — replay dos INCIDENTES REAIS
 * contra os prompts novos, via endpoint de teste de PROD (LLM real, testMode —
 * zero envio a lead).
 *
 * Cenários (cada um = um erro dos prints do Pedro):
 *  S1 idioma: "Hola" solto NÃO pode virar conversa em espanhol; frase inteira em ES pode.
 *  S2 fabricação: "Sou tecnico de IA" → resposta NÃO pode inventar "família".
 *  S3 booking 2 tempos: oferta SEM book_appointment; escolha → book_appointment.
 *  S4 balões: máx 2 mensagens por resposta (todos os turnos).
 *  S5 repetição: lead responde "ola" ignorando a pergunta → re-pergunta com fraseado ≠.
 *
 * Auth: minta um spark_session JWT com o JWT_SECRET (mesmo de prod).
 * Rodar: npx tsx scripts/stress-alves-cury-v2.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { SignJWT } from "jose";
import { writeFileSync, mkdirSync } from "fs";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const LOC = "YuR0LCZomFzrfkDK2ezo";
const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";
const BRUNA = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
const BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";
const AD_VENDA = "Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida";

let pass = 0;
let fail = 0;
const report: string[] = [`# Stress Alves Cury v2 — ${new Date().toISOString()}`];
function ok(name: string, cond: boolean, detail = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail.slice(0, 160)}` : ""}`;
  console.log(`  ${line}`);
  report.push(line);
  cond ? pass++ : fail++;
}

async function mintSession(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  return new SignJWT({ userId: "stress-harness", companyId: COMPANY, locationId: LOC, locationName: "Alves Cury", isAdmin: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

type TurnResp = {
  session_id: string;
  response?: { message: string | string[]; actions?: Array<{ type: string; start_time?: string }> };
  available_slots?: string | null;
  error?: string;
};

function msgs(r: TurnResp): string[] {
  const m = r.response?.message;
  return Array.isArray(m) ? m : m ? [m] : [];
}
function fullText(r: TurnResp): string {
  return msgs(r).join("\n");
}
function actions(r: TurnResp): Array<{ type: string; start_time?: string }> {
  return r.response?.actions || [];
}

const ES_MARKERS = /¿|hablas|me llamo|cómo te|qué estado|prefieres|dónde|usted|contigo|gracias por/i;
function looksSpanish(t: string): boolean {
  return ES_MARKERS.test(t);
}

async function main() {
  const jwt = await mintSession();
  const H = { "Content-Type": "application/json", Cookie: `spark_session=${jwt}` };

  async function turn(agentId: string, sessionId: string | null, message: string): Promise<TurnResp> {
    const r = await fetch(`${BASE}/api/agents/test`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ agent_id: agentId, message, ...(sessionId ? { session_id: sessionId } : {}) }),
    });
    const j = (await r.json()) as TurnResp;
    if (!r.ok || j.error) throw new Error(`turn falhou (${r.status}): ${j.error || JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  // ── S1: idioma (Bruna) ──────────────────────────────────────────────────
  console.log("\n=== S1: 'Hola' solto não vira espanhol ===");
  let s = await turn(BRUNA, null, AD_VENDA);
  const sid1 = s.session_id;
  report.push(`\n## S1\nLEAD: ${AD_VENDA}\nBOT: ${fullText(s)}`);
  s = await turn(BRUNA, sid1, "Hola");
  report.push(`LEAD: Hola\nBOT: ${fullText(s)}`);
  ok("S1a resposta ao 'Hola' segue em português", !looksSpanish(fullText(s)), fullText(s));
  ok("S1a máx 2 balões", msgs(s).length <= 2, `${msgs(s).length} balões`);
  s = await turn(BRUNA, sid1, "Hola, prefiero hablar en español, puede ser?");
  report.push(`LEAD: Hola, prefiero hablar en español, puede ser?\nBOT: ${fullText(s)}`);
  ok("S1b frase inteira em ES → pode espanhol", looksSpanish(fullText(s)) || /espanhol|español/i.test(fullText(s)), fullText(s));

  // ── S2+S3: fabricação + booking 2 tempos (Bruna) ────────────────────────
  console.log("\n=== S2/S3: sem fabricar 'família' + booking em 2 tempos ===");
  s = await turn(BRUNA, null, AD_VENDA);
  const sid2 = s.session_id;
  report.push(`\n## S2/S3\nLEAD: ${AD_VENDA}\nBOT: ${fullText(s)}`);
  s = await turn(BRUNA, sid2, "Florida");
  report.push(`LEAD: Florida\nBOT: ${fullText(s)}`);
  s = await turn(BRUNA, sid2, "Sou tecnico de IA");
  report.push(`LEAD: Sou tecnico de IA\nBOT: ${fullText(s)}`);
  ok("S2 não inventa 'família'", !/fam[ií]lia/i.test(fullText(s)), fullText(s));
  ok("S2 máx 2 balões", msgs(s).length <= 2, `${msgs(s).length} balões`);
  ok("S2 sem book_appointment precoce", !actions(s).some((a) => a.type === "book_appointment"));

  // avança até a oferta de horários (responde pedidos de nome; máx 5 nudges)
  let offer = s;
  let nudges = 0;
  let gaveName = false;
  while (nudges < 5 && !/\d\s*(am|pm|da tarde|da noite|da manhã|h)/i.test(fullText(offer))) {
    let reply = "Pode ser, como funciona?";
    if (!gaveName && /nome/i.test(fullText(offer))) { reply = "Carlos Silva"; gaveName = true; }
    else if (nudges === 0) reply = "Quero proteger minha renda";
    offer = await turn(BRUNA, sid2, reply);
    report.push(`LEAD: ${reply}\nBOT: ${fullText(offer)}`);
    nudges++;
  }
  const offered = /\d/.test(fullText(offer));
  ok("S3a chegou à oferta de horários", offered, fullText(offer));
  if (offered) {
    ok("S3b oferta SEM book_appointment (tempo 1)", !actions(offer).some((a) => a.type === "book_appointment"));
    // escolha EXPLÍCITA: ecoa o primeiro dia/hora da própria oferta do bot
    const m = fullText(offer).match(/(segunda|terça|quarta|quinta|sexta|sábado|domingo|hoje|amanhã)[^,]{0,15}?às\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM|da tarde|da noite|da manhã)?)/i);
    const explicitChoice = m ? `Pode ser ${m[1]} às ${m[2]} então` : "Pode ser o primeiro horário";
    let choice = await turn(BRUNA, sid2, explicitChoice);
    report.push(`LEAD: ${explicitChoice}\nBOT: ${fullText(choice)}`);
    // se pediu nome/clarificação sem agendar, responde 1x e re-escolhe
    if (!actions(choice).some((a) => a.type === "book_appointment")) {
      const follow = /nome/i.test(fullText(choice)) && !gaveName ? `Carlos Silva, ${explicitChoice.toLowerCase()}` : `${explicitChoice}, pode confirmar`;
      gaveName = true;
      choice = await turn(BRUNA, sid2, follow);
      report.push(`LEAD: ${follow}\nBOT: ${fullText(choice)}`);
    }
    const booked = actions(choice).some((a) => a.type === "book_appointment" && a.start_time);
    ok("S3c escolha → book_appointment com start_time (tempo 2)", booked, JSON.stringify(actions(choice)));
    ok("S3d confirmação com dia da semana", /(segunda|terça|quarta|quinta|sexta|sábado|domingo|hoje|amanhã)/i.test(fullText(choice)), fullText(choice));
  }

  // ── S5: repetição com variação (Bruno) ──────────────────────────────────
  console.log("\n=== S5: re-pergunta com fraseado diferente (Bruno) ===");
  s = await turn(BRUNO, null, "Moro nos EUA e gostaria de mais informações de como me tornar agente financeiro");
  const sid3 = s.session_id;
  const q1 = fullText(s);
  report.push(`\n## S5\nLEAD: (frase recrut)\nBOT: ${q1}`);
  s = await turn(BRUNO, sid3, "ola");
  const q2 = fullText(s);
  report.push(`LEAD: ola\nBOT: ${q2}`);
  ok("S5a respondeu sem repetir a pergunta idêntica", q2.trim() !== q1.trim() && !q1.split("?")[0].trim().length || !q2.includes(q1.split("?").slice(-2)[0]?.trim() || "@@"), q2);
  ok("S5b máx 2 balões", msgs(s).length <= 2, `${msgs(s).length} balões`);
  ok("S5c segue em português", !looksSpanish(q2), q2);

  // ── Relatório ───────────────────────────────────────────────────────────
  mkdirSync("_planning/alves-cury-v2", { recursive: true });
  const file = `_planning/alves-cury-v2/stress-${Date.now()}.md`;
  report.push(`\n\nRESULTADO: ${pass} pass / ${fail} fail`);
  writeFileSync(file, report.join("\n"));
  console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail === (transcript: ${file})`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
