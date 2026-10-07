/**
 * H101 — nunca dois agentes no mesmo contato (caso Alves Cury 07/10 18:07 UTC).
 * Testa a guarda contra os dados REAIS do incidente. READ-ONLY.
 *   npx tsx scripts/test-dois-agentes.ts
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { outroAgenteNaConversa } from "../src/lib/account-assistant/proactive/reactive-trigger";
const LOC = "YuR0LCZomFzrfkDK2ezo";
const BRUNA = "e698f2b4-92bf-4c6a-9429-dc18ab94096b", BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";
let ok = 0, fail = 0;
const t = (n: string, c: boolean, d = "") => { if (c) { ok++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };
(async () => {
  const sb = createAdminClient();
  // o contato do incidente: a Bruna tem conversa com ele
  const r1 = await outroAgenteNaConversa(sb, LOC, BRUNO, "1ajBkGersnYd9OWn9Ebh");
  t("incidente 18:08: Bruno é barrado porque a Bruna já está na conversa", r1 !== null, `→ ${r1}`);
  // contato que SÓ a Bruna atendeu, perguntando pela própria Bruna: não é "outro"
  const { data: soBruna } = await sb.from("conversation_state").select("contact_id").eq("agent_id", BRUNA).eq("location_id", LOC).limit(50);
  let soDela: string | null = null;
  for (const r of soBruna || []) {
    const { count } = await sb.from("conversation_state").select("id", { count: "exact", head: true }).eq("contact_id", (r as { contact_id: string }).contact_id).neq("agent_id", BRUNA);
    if (!count) { soDela = (r as { contact_id: string }).contact_id; break; }
  }
  if (soDela) t("o próprio agente não conta como 'outro'", (await outroAgenteNaConversa(sb, LOC, BRUNA, soDela)) === null);
  t("contato que ninguém atendeu → livre", (await outroAgenteNaConversa(sb, LOC, BRUNO, "contato-que-nao-existe-xyz")) === null);
  console.log(`\nRESULTADO: ${ok} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
})();
