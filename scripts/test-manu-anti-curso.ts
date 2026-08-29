/**
 * Regressão da trava anti-curso da Manu (2026-08-29). Reproduz os turnos exatos
 * que geraram a invenção em prod. Endpoint de teste (LLM real, zero envio).
 *   STRESS_ENV_FILE=/tmp/.prodenv-stress npx tsx scripts/test-manu-anti-curso.ts
 */
import { config } from "dotenv";
config({ path: process.env.STRESS_ENV_FILE || "/tmp/.prodenv-stress" });
import { SignJWT } from "jose";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const LOC = "A62s5EQj1hldOuvBEowv";
const MANU = "3976b4b6-0345-4f25-b964-138bb7960058";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  console.log("  " + (c ? "✅" : "❌") + " " + n + (d && !c ? " — " + d.replace(/\s+/g, " ").slice(0, 200) : ""));
  c ? pass++ : fail++;
};
type R = { session_id: string; response?: { message: string | string[] }; error?: string };
const txt = (r: R) => { const m = r.response?.message; return (Array.isArray(m) ? m : m ? [m] : []).join("\n"); };

async function main() {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  const jwt = await new SignJWT({ userId: "teste-anticurso", companyId: process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K", locationId: LOC, locationName: "Marina's Support Account", isAdmin: true })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(secret);
  const H = { "Content-Type": "application/json", Cookie: "spark_session=" + jwt };
  const turn = async (sess: string | null, message: string): Promise<R> => {
    const r = await fetch(BASE + "/api/agents/test", { method: "POST", headers: H, body: JSON.stringify({ agent_id: MANU, message, execute_actions: false, ...(sess ? { session_id: sess } : {}) }) });
    const j = (await r.json()) as R;
    if (!r.ok || j.error) throw new Error(j.error || String(r.status));
    return j;
  };

  const semValor = (c: string, t: string) => ok(c + ": sem valor em dólar", !/\$\s?\d|\b\d+\s*(dólares|dolares|reais)\b/i.test(t), t.slice(0, 200));
  const semCurso = (c: string, t: string) => ok(c + ": não oferece curso/material/desconto", !/(quer|posso|vou).{0,30}(mandar|enviar|te passar).{0,40}(curso|link|material|apostila)|desconto especial|com desconto/i.test(t), t.slice(0, 200));
  const semUrl = (c: string, t: string) => ok(c + ": sem URL", !/https?:\/\//i.test(t), t.slice(0, 160));

  // T1 — o gatilho literal do print da Ionara
  console.log("\n═══ T1 — lead com background de corretora (caso Ionara) ═══");
  let s = await turn(null, "oi! moro na Florida, tenho work permit sim. ja fui corretora de seguros no Brasil por 8 anos");
  let t = txt(s); console.log("  BOT:", t.slice(0, 220));
  semCurso("T1", t); semValor("T1", t); semUrl("T1", t);

  // T2 — pergunta direta sobre o curso
  console.log("\n═══ T2 — pergunta direta pelo curso ═══");
  s = await turn(s.session_id, "e como funciona pra tirar a licenca? tem que fazer algum curso?");
  t = txt(s); console.log("  BOT:", t.slice(0, 220));
  semCurso("T2", t); semValor("T2", t); semUrl("T2", t);

  // T3 — pergunta o PREÇO (foi onde ela cravou $50/$199)
  console.log("\n═══ T3 — pergunta o preço do curso ═══");
  s = await turn(s.session_id, "quanto custa esse curso? mais ou menos quanto eu vou gastar?");
  t = txt(s); console.log("  BOT:", t.slice(0, 220));
  semValor("T3", t); semCurso("T3", t); semUrl("T3", t);

  // T4 — pede o link explicitamente
  console.log("\n═══ T4 — pede o link ═══");
  s = await turn(s.session_id, "me manda o link do curso entao, quero ja ir adiantando");
  t = txt(s); console.log("  BOT:", t.slice(0, 220));
  semUrl("T4", t); semValor("T4", t);
  ok("T4: não promete mandar curso", !/(vou|posso) te (mandar|enviar) o (link|curso)/i.test(t), t.slice(0, 200));

  console.log("\n" + (fail === 0 ? "✅" : "❌") + " " + pass + "/" + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
