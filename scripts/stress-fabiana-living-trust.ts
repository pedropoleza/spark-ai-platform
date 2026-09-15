/**
 * Replay das 2 configurações da Fabiana (15/09) contra o LLM REAL, via endpoint
 * de teste de prod (testMode — zero envio a lead).
 *
 * Os cenários F1/F2 são as mensagens LITERAIS de produção que geraram a queixa:
 * em 13/09 o lead disse "seria um trust, podemos marcar um call" e a IA
 * respondeu "a Fabiana esclarece melhor na reunião" e AGENDOU (execution_log
 * book_appointment 16:12) — reunião de um serviço que não existe.
 *
 * F3/F4 são os contra-testes: a regra não pode desclassificar quem quer um
 * produto real, nem prender quem pivota depois da negativa.
 *
 * Rodar: npx tsx scripts/stress-fabiana-living-trust.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: process.env.STRESS_ENV_FILE || resolve(__dirname, "..", ".env.local") });
import { SignJWT } from "jose";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const LOC = "7pXJZ8WUq0GpVh0Qd2Ew";
const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";
const NAYANE = "00c7201f-1618-49d5-b79e-c06aed0cd566"; // produtos
const RAISSA = "37bfb23b-0bbf-47f1-bcac-a0eb92aecf98"; // recrutamento

const TRUST_1 = "B dia , seria um trust, podemos marcar um call para amanhã ?";
const TRUST_2 = "B dia , qual o tel de contato? gostaria de conversar consigo sobre seus services ,preciso fazer um trust";
const PRODUTO = "Gostaria de mais informacoes sobre o BENEFICIO EM VIDA";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  cond ? pass++ : fail++;
}

type TurnResp = {
  session_id: string;
  response?: {
    message: string | string[];
    actions?: Array<{ type: string }>;
    collected_data?: Record<string, string>;
    conversation_status?: string;
  };
  error?: string;
};
const msgs = (r: TurnResp) => (Array.isArray(r.response?.message) ? r.response!.message : r.response?.message ? [r.response.message] : []);
const full = (r: TurnResp) => msgs(r).join("\n");
const agendou = (r: TurnResp) => (r.response?.actions ?? []).some((a) => a.type === "book_appointment");
const campo = (r: TurnResp) => r.response?.collected_data?.servico_nao_atendido ?? "";

const RE_NEGA = /n[ãa]o (trabalha|trabalhamos|oferece|oferecemos|fazemos|faz)|advogado|sucess[óo]rio|fora d[oa] (nossa|minha) [áa]rea/i;
const RE_EMPURRA = /na reuni[ãa]o|na consultoria|na chamada|a Fabiana (vai )?(explica|esclarece|detalha)/i;

async function main() {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  const jwt = await new SignJWT({ userId: "stress-fab", companyId: COMPANY, locationId: LOC, locationName: "Fabiana Campos", isAdmin: true })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(secret);
  const H = { "Content-Type": "application/json", Cookie: `spark_session=${jwt}` };

  async function turn(agentId: string, sessionId: string | null, message: string): Promise<TurnResp> {
    const r = await fetch(`${BASE}/api/agents/test`, {
      method: "POST", headers: H,
      body: JSON.stringify({ agent_id: agentId, message, ...(sessionId ? { session_id: sessionId } : {}) }),
    });
    const j = (await r.json()) as TurnResp;
    if (!r.ok || j.error) throw new Error(`turn falhou (${r.status}): ${j.error || JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  console.log("\n=== F1: mensagem LITERAL do lead Giovani (13/09) — pediu trust + call ===");
  let s = await turn(NAYANE, null, TRUST_1);
  console.log(`  BOT: ${full(s)}`);
  ok("F1a NÃO agenda", !agendou(s), agendou(s) ? "book_appointment presente!" : "");
  ok("F1b diz claramente que não trabalha com isso", RE_NEGA.test(full(s)), full(s).slice(0, 160));
  ok("F1c NÃO empurra pra reunião (o bug de 13/09)", !RE_EMPURRA.test(full(s)), full(s).slice(0, 160));
  ok("F1d marca o campo servico_nao_atendido=living_trust", campo(s).includes("living_trust"), `campo="${campo(s)}"`);

  console.log("\n=== F2: outra mensagem real (13/09 12:39) — 'preciso fazer um trust' ===");
  s = await turn(NAYANE, null, TRUST_2);
  console.log(`  BOT: ${full(s)}`);
  ok("F2a NÃO agenda", !agendou(s));
  ok("F2b nega o serviço", RE_NEGA.test(full(s)), full(s).slice(0, 160));
  ok("F2c marca o campo", campo(s).includes("living_trust"), `campo="${campo(s)}"`);

  console.log("\n=== F3: CONTRA-TESTE — lead de produto real não pode ser desclassificado ===");
  s = await turn(NAYANE, null, PRODUTO);
  console.log(`  BOT: ${full(s)}`);
  ok("F3a NÃO marca o campo", !campo(s).includes("living_trust"), `campo="${campo(s)}"`);
  ok("F3b segue o atendimento normal", !RE_NEGA.test(full(s)), full(s).slice(0, 160));

  console.log("\n=== F4: pivô — depois da negativa, lead quer aposentadoria ===");
  s = await turn(NAYANE, null, TRUST_1);
  const sid = s.session_id;
  s = await turn(NAYANE, sid, "Ah entendi. Então me fala sobre a aposentadoria em dólar");
  console.log(`  BOT: ${full(s)}`);
  ok("F4a atende o produto real", /aposentadoria|renda|d[óo]lar|consultoria|Fabiana/i.test(full(s)), full(s).slice(0, 160));

  console.log("\n=== F5/F6: nome das assistentes ===");
  s = await turn(NAYANE, null, "Oi, com quem eu falo?");
  console.log(`  NAYANE: ${full(s)}`);
  ok("F5 produtos se apresenta como Nayane (e não Gian)", /nayane/i.test(full(s)) && !/\bgian\b/i.test(full(s)), full(s).slice(0, 160));
  s = await turn(RAISSA, null, "Oi, com quem eu falo?");
  console.log(`  RAÍSSA: ${full(s)}`);
  ok("F6 recrutamento se apresenta como Raíssa (e não Pedro)", /ra[íi]ssa/i.test(full(s)) && !/\bpedro\b/i.test(full(s)), full(s).slice(0, 160));

  console.log(`\n${"=".repeat(50)}\n${pass} passaram, ${fail} falharam\n${"=".repeat(50)}`);
}

main().then(() => process.exit(fail ? 1 : 0)).catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
