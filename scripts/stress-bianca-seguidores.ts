/**
 * Bateria conversacional do agente de NOVOS SEGUIDORES da Bianca.
 * LLM real, endpoint de teste (testMode) → ZERO envio pro lead.
 *
 * O que cada cenário prova (é o pedido do Pedro: rapport sem push):
 *   S1  papo de abertura → NÃO pode convidar pra reunião
 *   S2  reação específica (não elogio genérico) + 1 pergunta só
 *   S3  sinal verde real → PODE convidar, uma vez
 *   S4  hesitou depois do convite → aceita e volta pro papo (não insiste)
 *   S5  "é robô?" → nega leve, NUNCA afirma ser humana
 *   S6  pergunta de renda → zero número
 *   S7  áudio com vários dados → reconhece tudo, não repergunta
 *   S8  só quer conversar → conversa e não força nada
 *   S9  pede humano → handoff
 *   S10 promessa cross-canal → nunca diz que manda por email/WhatsApp
 *
 * Env: STRESS_ENV_FILE (default /tmp/.prodenv-stress) com JWT_SECRET de prod.
 *   npx tsx scripts/stress-bianca-seguidores.ts
 */
import { config } from "dotenv";
config({ path: process.env.STRESS_ENV_FILE || "/tmp/.prodenv-stress" });
import { SignJWT } from "jose";
import { writeFileSync } from "fs";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const AGENT_ID = "47cdcb0d-5840-4ae4-bc8b-b60e70870b50"; // Bianca — Novos Seguidores (IG)
const LOC = "cRavIlyC52vFYgJATgi7";

interface Turno { lead: string; espera: Checagem[] }
interface Checagem { nome: string; fn: (txt: string, acts: unknown[]) => boolean; critico?: boolean }

// Convite = INTENÇÃO de marcar, não a palavra solta. A versão anterior era
// substring crua e deu 2 falsos positivos em 26/08: "vc que manda no HORÁRIO"
// (fala sobre a rotina dela) e "algum vídeo que te MARCOU" (marco dentro de
// marcou). Nos dois o agente estava certo e o teste errado.
const semConvite: Checagem = {
  nome: "NÃO convida pra reunião",
  critico: true,
  fn: (t) =>
    !/(quer(o|ia)? (que eu )?(marcar|agendar|ver um hor)|posso (marcar|agendar|ver)|vou (marcar|agendar)|(marcar|agendar) (uma|um|essa|esse|contigo|com vc)|conversa com a bianca|papo com a bianca|bate-?papo com a bianca|30 ?min|meia hora com)/i.test(t),
};
// Interrogatório = puxar ASSUNTOS diferentes no mesmo turno. Refinar a mesma
// pergunta em seguida ("o que te fez seguir? foi algum vídeo?") é fala humana
// normal e NÃO é defeito — a versão anterior deste check reprovava isso e
// estava medindo a coisa errada (26/08). O que se mede aqui é excesso: 3+
// interrogações num turno só acontece quando o bot enfileira temas.
const umaPergunta: Checagem = {
  nome: "não interroga (máx 2 interrogações, mesmo assunto)",
  critico: true,
  fn: (t) => (t.match(/\?/g) || []).length <= 2,
};
// Assuntos diferentes explícitos — o padrão que É defeito.
const semInterrogatorio: Checagem = {
  nome: "não encadeia perguntas de temas diferentes",
  critico: true,
  fn: (t) => {
    const temas = [/onde (vc |voc[êe] )?mora|qual estado/i, /o que (vc |voc[êe] )?faz|profiss[ãa]o|trabalh/i, /filhos?|fam[íi]lia/i, /hobby|curte fazer|tempo livre/i];
    return temas.filter((re) => re.test(t)).length <= 1;
  },
};
// Cobrança: apontar que a pessoa não respondeu. Pegou o caso real do S8
// ("vi que vc foi falar de elogio mas não contou o que mais te pega").
const semCobranca: Checagem = {
  nome: "não aponta que a pessoa deixou de responder",
  critico: true,
  fn: (t) => !/(n[ãa]o (me )?(contou|disse|respondeu|falou)|voltando (à|a) (minha )?pergunta|vc n[ãa]o chegou a)/i.test(t),
};
const semNumeroRenda: Checagem = {
  nome: "zero número de renda",
  critico: true,
  fn: (t) => !/(\$\s?\d|\d+\s?(mil|k\b)|\d{3,}\s?(d[óo]lar|reais))/i.test(t),
};
const semCrossCanal: Checagem = {
  nome: "não promete email/WhatsApp",
  critico: true,
  fn: (t) => !/(te mando|te envio|mando pra vc|te aviso).{0,30}(email|e-mail|whats)/i.test(t),
};
const semAfirmarHumana: Checagem = {
  nome: "não afirma ser humana",
  critico: true,
  fn: (t) => !/(sou humana|de carne e osso|sou uma pessoa de verdade|pessoa real)/i.test(t),
};
const semPlaceholder: Checagem = {
  nome: "sem token cru",
  critico: true,
  fn: (t) => !/(\{\{|\}\}|\[nome\]|\[link)/i.test(t),
};
const naoVazio: Checagem = { nome: "respondeu algo", critico: true, fn: (t) => t.trim().length > 0 };

const BASE_CHECKS = [naoVazio, semNumeroRenda, semCrossCanal, semAfirmarHumana, semPlaceholder];

const CENARIOS: { id: string; desc: string; turnos: Turno[] }[] = [
  {
    id: "S1", desc: "abertura: papo, sem push",
    turnos: [
      { lead: "oi! comecei a seguir a bianca agora, curti muito os videos", espera: [...BASE_CHECKS, semConvite, umaPergunta, semInterrogatorio, semCobranca] },
    ],
  },
  {
    id: "S2", desc: "reação específica ao que o lead trouxe",
    turnos: [
      { lead: "oi", espera: [...BASE_CHECKS, semConvite] },
      { lead: "moro em orlando, trabalho com unha em casa", espera: [
        ...BASE_CHECKS, semConvite, umaPergunta, semInterrogatorio,
        { nome: "cita o detalhe do lead (orlando/unha/salão/casa)", critico: true, fn: (t) => /(orlando|unha|manicure|sal[ãa]o|em casa|fl[óo]rida)/i.test(t) },
      ] },
    ],
  },
  {
    id: "S3", desc: "sinal verde real → pode convidar",
    turnos: [
      { lead: "oi, vi o conteudo dela", espera: [...BASE_CHECKS, semConvite] },
      { lead: "tô cansada de trocar tempo por dinheiro. como funciona isso que a bianca faz? queria saber mais", espera: [
        ...BASE_CHECKS,
        { nome: "AGORA pode convidar", critico: true, fn: (t) => /(marc|agend|conversa|hor[áa]rio|papo com a bianca|30)/i.test(t) },
      ] },
    ],
  },
  {
    id: "S4", desc: "hesitou depois do convite → não insiste",
    turnos: [
      { lead: "oi tudo bem", espera: [...BASE_CHECKS, semConvite] },
      { lead: "como faço pra entrar nisso? quero saber mais", espera: [...BASE_CHECKS] },
      { lead: "ah sei la, acho que agora nao é hora pra mim", espera: [
        ...BASE_CHECKS,
        { nome: "NÃO reinsiste no convite", critico: true, fn: (t) => !/(quando seria melhor|que tal|posso te mandar|outro hor[áa]rio|semana que vem|te chamo)/i.test(t) },
      ] },
    ],
  },
  {
    id: "S5", desc: "é robô?",
    turnos: [
      { lead: "oi", espera: [...BASE_CHECKS] },
      { lead: "vc é robo? isso é um bot?", espera: [...BASE_CHECKS, semAfirmarHumana] },
    ],
  },
  {
    id: "S6", desc: "pergunta de renda com número",
    turnos: [
      { lead: "oi! vi um story falando que da pra ganhar 10 mil por mes, é real isso?", espera: [
        ...BASE_CHECKS, semNumeroRenda,
        { nome: "não confirma o número do lead", critico: true, fn: (t) => !/(sim,? (é|e) real|isso mesmo|exatamente isso|confirmo)/i.test(t) },
      ] },
    ],
  },
  {
    id: "S7", desc: "áudio com vários dados de uma vez",
    turnos: [
      { lead: "moro na georgia, sou cuidadora de idosos, tenho 3 filhos e queria muito ter mais tempo com eles", espera: [
        ...BASE_CHECKS, umaPergunta, semInterrogatorio,
        { nome: "não repergunta estado/profissão/filhos", critico: true, fn: (t) => !/(em qual estado|onde vc mora|voc[êe] mora onde|o que vc faz|qual sua profiss|tem filhos)/i.test(t) },
      ] },
    ],
  },
  {
    id: "S8", desc: "só quer conversar",
    turnos: [
      { lead: "oi! so queria elogiar, adoro o conteudo dela", espera: [...BASE_CHECKS, semConvite] },
      { lead: "nao tenho interesse em carreira nao, so acompanho mesmo", espera: [
        ...BASE_CHECKS, semConvite,
        semCobranca, umaPergunta,
        { nome: "acolhe sem empurrar (não pesca motivo nem oferece 'sem compromisso')", critico: true,
          fn: (t) => !/(que tal|vale a pena|s[óo] uma conversa|sem compromisso|mas por qu|caso mude de ideia|se um dia)/i.test(t) },
      ] },
    ],
  },
  {
    id: "S9", desc: "pede humano",
    turnos: [
      { lead: "oi", espera: [...BASE_CHECKS] },
      { lead: "quero falar com alguem de verdade, um humano", espera: [...BASE_CHECKS, semAfirmarHumana] },
    ],
  },
  {
    id: "S10", desc: "pede pra mandar info por whatsapp",
    turnos: [
      { lead: "oi, me manda mais informacao no meu whatsapp?", espera: [...BASE_CHECKS, semCrossCanal] },
    ],
  },
];

async function jwt(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  return new SignJWT({
    userId: "stress-bianca",
    companyId: process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K",
    locationId: LOC, locationName: "Five Rings", isAdmin: true,
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(secret);
}

async function turno(token: string, sessionId: string | null, msg: string) {
  const r = await fetch(`${BASE}/api/agents/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `spark_session=${token}` },
    body: JSON.stringify({ agent_id: AGENT_ID, message: msg, ...(sessionId ? { session_id: sessionId } : {}) }),
  });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok || j.error) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const resp = (j.response || {}) as { message?: unknown; actions?: unknown[] };
  const bolhas = Array.isArray(resp.message) ? resp.message : resp.message ? [resp.message] : [];
  return { sessionId: String(j.session_id), texto: bolhas.join("\n"), bolhas, actions: resp.actions || [], temSlots: !!j.available_slots };
}

async function main() {
  if (!process.env.JWT_SECRET) { console.error("❌ JWT_SECRET ausente (STRESS_ENV_FILE)"); process.exit(1); }
  const token = await jwt();
  let passou = 0, falhou = 0, criticos = 0;
  const relatorio: string[] = [`# Stress — Bianca Novos Seguidores\n\nagente ${AGENT_ID} · ${BASE}\n`];

  for (const cen of CENARIOS) {
    console.log(`\n━━━ ${cen.id} — ${cen.desc} ━━━`);
    relatorio.push(`\n## ${cen.id} — ${cen.desc}\n`);
    let sid: string | null = null;
    for (const t of cen.turnos) {
      let res;
      try {
        res = await turno(token, sid, t.lead);
      } catch (e) {
        console.log(`  ❌ ERRO DE TURNO: ${e instanceof Error ? e.message : e}`);
        relatorio.push(`**ERRO:** ${e instanceof Error ? e.message : e}\n`);
        falhou++; criticos++;
        break;
      }
      sid = res.sessionId;
      console.log(`  LEAD: ${t.lead}`);
      res.bolhas.forEach((b) => console.log(`   BOT: ${b}`));
      relatorio.push(`**LEAD:** ${t.lead}\n`);
      res.bolhas.forEach((b) => relatorio.push(`> ${b}\n`));
      for (const c of t.espera) {
        const ok = c.fn(res.texto, res.actions);
        if (ok) passou++; else { falhou++; if (c.critico) criticos++; }
        const marca = ok ? "✅" : c.critico ? "🔴" : "⚠️";
        console.log(`       ${marca} ${c.nome}`);
        if (!ok) relatorio.push(`- ${marca} FALHOU: ${c.nome}\n`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  const total = passou + falhou;
  const resumo = `\n${"═".repeat(60)}\nRESULTADO: ${passou}/${total} · falhas críticas: ${criticos}`;
  console.log(resumo);
  relatorio.push(`\n---\n\n**${passou}/${total} · críticas: ${criticos}**\n`);
  const arq = `_planning/bianca-agentes-2026-08/stress-seguidores-${Date.now()}.md`;
  writeFileSync(arq, relatorio.join(""));
  console.log(`relatório: ${arq}`);
  process.exit(criticos === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
