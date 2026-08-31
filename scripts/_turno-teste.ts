/**
 * Driver de 1 turno contra o endpoint de teste de prod (testMode, zero envio).
 * Uso: npx tsx scripts/_turno-teste.ts <bruna|bruno> <session_id|new> "<mensagem do lead>"
 * Saída: JSON {session_id, bolhas[], actions[], tem_slots}
 * Env: STRESS_ENV_FILE (default /tmp/.prodenv-stress) precisa ter JWT_SECRET de prod.
 */
import { config } from "dotenv";
config({ path: process.env.STRESS_ENV_FILE || "/tmp/.prodenv-stress" });
import { SignJWT } from "jose";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const IDS: Record<string, string> = {
  bruna: "e698f2b4-92bf-4c6a-9429-dc18ab94096b",
  bruno: "a0339877-7096-4384-a2d8-34d9daedb339",
  jussara: "a297dadc-873a-4803-885d-472c65414168",
};

async function main() {
  const [agente, sess, msg] = process.argv.slice(2);
  const agentId = IDS[agente];
  if (!agentId || !msg) {
    console.error('uso: _turno-teste.ts <bruna|bruno> <session_id|new> "mensagem"');
    process.exit(2);
  }
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  const jwt = await new SignJWT({
    userId: "wf-teste", companyId: process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K",
    locationId: process.env.TURNO_LOC || "YuR0LCZomFzrfkDK2ezo", locationName: "Alves Cury", isAdmin: true,
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(secret);

  const r = await fetch(`${BASE}/api/agents/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `spark_session=${jwt}` },
    body: JSON.stringify({ agent_id: agentId, message: msg, ...(sess && sess !== "new" ? { session_id: sess } : {}) }),
  });
  const j: any = await r.json();
  if (!r.ok || j.error) {
    console.error(`ERRO ${r.status}: ${j.error || JSON.stringify(j).slice(0, 200)}`);
    process.exit(1);
  }
  const m = j.response?.message;
  console.log(JSON.stringify({
    session_id: j.session_id,
    bolhas: Array.isArray(m) ? m : m ? [m] : [],
    actions: j.response?.actions || [],
    status: j.response?.conversation_status || null,
    tem_slots: !!(j.available_slots && String(j.available_slots).trim()),
  }));
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
