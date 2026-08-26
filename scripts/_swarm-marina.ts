/**
 * Driver de 1 turno contra o agente de PÓS-ATENDIMENTO da Marina Couto,
 * via endpoint de teste de prod (testMode; execute_actions=false → ZERO envio,
 * ZERO escrita no CRM). Usado pelo swarm adversarial de 2026-08-25.
 *
 * Uso: npx tsx scripts/_swarm-marina.ts <session_id|new> "<mensagem do lead>"
 * Saída: JSON {session_id, bolhas[], actions[], status}
 * Env: STRESS_ENV_FILE (default /tmp/.prodenv-stress) com JWT_SECRET de prod.
 */
import { config } from "dotenv";
config({ path: process.env.STRESS_ENV_FILE || "/tmp/.prodenv-stress" });
import { SignJWT } from "jose";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
// Transferência 2026-08-25 (decisão Pedro): o pós-atendimento roda na PERSONAL
// (é lá que o WhatsApp API dela vive). A Support (A62s5EQj1hldOuvBEowv) segue
// sendo o topo de funil do Instagram com a Manu.
const LOC = "ONRf1DUKVnfxivEGxcTj";
const AGENT = process.env.SWARM_AGENT || "d4894e2a-43fa-4b2f-8949-0bbd941be2b9";

async function main() {
  const [sess, msg] = process.argv.slice(2);
  if (!msg) {
    console.error('uso: _swarm-marina.ts <session_id|new> "mensagem"');
    process.exit(2);
  }
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  const jwt = await new SignJWT({
    userId: "swarm-marina",
    companyId: process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K",
    locationId: LOC,
    locationName: "Marina Couto",
    isAdmin: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("3h")
    .sign(secret);

  const r = await fetch(`${BASE}/api/agents/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `spark_session=${jwt}` },
    body: JSON.stringify({
      agent_id: AGENT,
      message: msg,
      ...(sess && sess !== "new" ? { session_id: sess } : {}),
      // explícito: nada de ação real (default já é false)
      execute_actions: false,
    }),
  });
  const j = (await r.json()) as {
    session_id?: string;
    error?: string;
    response?: { message?: string | string[]; actions?: unknown[]; conversation_status?: string };
  };
  if (!r.ok || j.error) {
    console.error(`ERRO ${r.status}: ${j.error || JSON.stringify(j).slice(0, 300)}`);
    process.exit(1);
  }
  const m = j.response?.message;
  console.log(
    JSON.stringify(
      {
        session_id: j.session_id,
        bolhas: Array.isArray(m) ? m : m ? [m] : [],
        actions: j.response?.actions || [],
        status: j.response?.conversation_status,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("ERR:", e?.message || e);
  process.exit(1);
});
