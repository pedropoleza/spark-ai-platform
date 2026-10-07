/**
 * H99 — o switch da IA com a conta desligada (caso Alves Cury, 07/10/2026).
 *
 * Roda os handlers de VERDADE (in-process, banco de produção) num contato onde o
 * efeito é o desejado: a Wellen Aleixo, agente da própria equipe que a IA abordou
 * por engano. "Desligar" nela tem que gravar a pausa pros DOIS agentes, inclusive
 * o que nunca falou com ela — o que o código antigo não fazia.
 *
 *   npx tsx scripts/test-switch-conta-desligada.ts
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { NextRequest } from "next/server";
import { createAdminClient } from "../src/lib/supabase/admin";
import { signSparkbotWebToken } from "../src/lib/account-assistant/web-auth";
import { GET as contactAgents } from "../src/app/api/agents/contact-agents/route";
import { POST as contactActivate } from "../src/app/api/agents/contact-activate/route";
import { GHLClient } from "../src/lib/ghl/client";

const LOC = "YuR0LCZomFzrfkDK2ezo";
let ok = 0, fail = 0;
const t = (n: string, c: boolean, d = "") => { if (c) { ok++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? "  → " + d : ""}`); } };

(async () => {
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  const CO = (loc as { company_id: string }).company_id;
  const ghl = new GHLClient(CO, LOC);
  const r = await ghl.get<{ contacts?: Array<{ id: string; firstName?: string; tags?: string[] }> }>("/contacts/", { locationId: LOC, query: "Wellen", limit: "3" });
  const wellen = (r.contacts || []).find((c) => (c.tags || []).includes("agent"));
  if (!wellen) { console.log("não achei a Wellen com tag agent — abortando sem escrever"); process.exit(1); }
  console.log(`contato: ${wellen.firstName} ${wellen.id} tags=${JSON.stringify(wellen.tags)}\n`);

  const token = await signSparkbotWebToken({ rep_id: "00000000-0000-0000-0000-000000000000", ghl_user_id: "pedro-via-claude", location_id: LOC, company_id: CO, is_admin: true });
  const auth = { authorization: `Bearer ${token}` };
  const { data: ags } = await sb.from("agents").select("id,name,status").eq("location_id", LOC).in("type", ["sales_agent", "recruitment_agent", "custom_agent"]);
  const ids = (ags || []).map((a) => (a as { id: string }).id);

  const antes = await sb.from("conversation_state").select("agent_id,ai_paused_at").eq("contact_id", wellen.id).in("agent_id", ids);
  console.log("ANTES:", JSON.stringify(antes.data));

  console.log("\n1. contact-agents com a conta desligada");
  const r1 = await (await contactAgents(new NextRequest(`https://x/api/agents/contact-agents?contactId=${wellen.id}`, { headers: auth }))).json();
  t("ícone aparece (hasAnyAgent) mesmo com tudo desligado", r1.hasAnyAgent === true, JSON.stringify(r1));
  t("conta marcada como desligada (accountOff)", r1.accountOff === true);
  t("os 2 agentes vêm, marcados como desligados", r1.agents?.length === 2 && r1.agents.every((a: { agentActive: boolean }) => a.agentActive === false));
  t("ninguém aparece 'atendendo' com a conta desligada", r1.activeAgentId === null);

  console.log("\n2. 'Desligar (ninguém atende)'");
  const r2 = await (await contactActivate(new NextRequest("https://x/api/agents/contact-activate", {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ contactId: wellen.id, agentId: null }),
  }))).json();
  t("rota responde ok", r2.ok === true, JSON.stringify(r2));
  const depois = await sb.from("conversation_state").select("agent_id,ai_paused_at,ai_paused_reason").eq("contact_id", wellen.id).in("agent_id", ids);
  console.log("DEPOIS:", JSON.stringify(depois.data));
  t("pausa gravada pros DOIS agentes (incl. o que nunca falou com ela)",
    (depois.data || []).length === 2 && (depois.data || []).every((s) => !!(s as { ai_paused_at: string | null }).ai_paused_at));

  console.log("\n3. o que o ícone mostra agora");
  const r3 = await (await contactAgents(new NextRequest(`https://x/api/agents/contact-agents?contactId=${wellen.id}`, { headers: auth }))).json();
  t("os 2 agentes 'paused' pra ela → ícone vermelho", r3.agents?.every((a: { state: string }) => a.state === "paused"), JSON.stringify(r3.agents));

  console.log("\n4. nada foi mandado pra ela");
  const { count: fila } = await sb.from("message_queue").select("id", { count: "exact", head: true }).eq("contact_id", wellen.id).gte("created_at", new Date(Date.now() - 120e3).toISOString());
  t("nenhuma mensagem enfileirada", (fila ?? 0) === 0);

  console.log(`\nRESULTADO: ${ok} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
})();
