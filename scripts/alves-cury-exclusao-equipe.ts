/**
 * Alves Cury — a IA abordou a PRÓPRIA EQUIPE e clientes (07/10/2026 20:10 UTC).
 *
 * Causa: o H88 ligou o recrutamento por `tUpk31fRxXs2bhxXYMh5 = "Recrutamento"`
 * achando que era "tipo de lead (Recrutamento/Venda)". O campo real se chama
 * "Ultimo Agendamento" (Primeiro Encontro / Segundo Encontro / Recrutamento) e
 * nem tem opção "Venda". Quando o time registra reunião de recrutamento com os
 * próprios agentes, o gatilho reativo dispara e a IA aborda o time.
 *
 * Correção:
 *  1. Tira o gatilho do campo de agendamento dos DOIS agentes (na Bruna ele era
 *     morto: "Venda" não existe no campo).
 *  2. Exclusão por tag de equipe/cliente, em E com a entrada (H81). Lista tirada
 *     das 88 tags reais da conta — inclui a variante digitada "undirect agent".
 *
 *   npx tsx scripts/alves-cury-exclusao-equipe.ts           # replay, não grava
 *   npx tsx scripts/alves-cury-exclusao-equipe.ts --apply   # grava (agentes seguem como estão)
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { checkContactMatchesTargeting } from "../src/lib/queue/targeting";
import { GHLClient } from "../src/lib/ghl/client";
import type { TargetingRules } from "../src/types/agent";

const LOC = "YuR0LCZomFzrfkDK2ezo";
const BRUNA = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
const BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";
const CF_AI = "C7LzKTXG3QHJuzfqOi9T"; // "AI": Venda / Recruit / Prospecção / Follow-up / Off
const APPLY = process.argv.includes("--apply");

const EQUIPE_E_CLIENTES = [
  "agent", "direct agent", "indirect agent", "undirect agent", "power team",
  "active client", "inactive client", "client", "cliente",
];
const exclusao = {
  id: "g-exclusao-equipe-cliente",
  match: "all" as const,
  rules: EQUIPE_E_CLIENTES.map((tag, i) => ({ id: `exc-${i}`, type: "tag" as const, tag, negate: true })),
};

export const NOVO_BRUNO = {
  version: 2, match: "all",
  groups: [
    { id: "g-entrada", match: "any", rules: [
      { id: "r-msg-agente", type: "message", message_operator: "contains", message_value: "agente financeiro" },
      { id: "r-headline", type: "message", message_operator: "contains", message_value: "Oportunidade para brasileiros" },
      { id: "ac-cf-recruit", type: "custom_field", custom_field_key: CF_AI, custom_field_value: "Recruit" },
    ] },
    exclusao,
  ],
} as unknown as TargetingRules;

export const NOVO_BRUNA = {
  version: 2, match: "all",
  groups: [
    { id: "g-entrada", match: "any", rules: [
      { id: "r-msg-seguro", type: "message", message_operator: "contains", message_value: "seguro" },
      { id: "r-msg-protecao", type: "message", message_operator: "contains", message_value: "proteção financeira" },
      { id: "r-headline-v", type: "message", message_operator: "contains", message_value: "Uma história real de proteção" },
      { id: "ac-cf-venda", type: "custom_field", custom_field_key: CF_AI, custom_field_value: "Venda" },
    ] },
    exclusao,
  ],
} as unknown as TargetingRules;

// Os 16 contatos que a IA abordou de 25/09 a 07/10, com o veredito esperado.
const CASOS: Array<{ id?: string; nome: string; deveBarrar: boolean }> = [];

async function main() {
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  const CO = (loc as { company_id: string }).company_id;
  const ghl = new GHLClient(CO, LOC);

  const { data: sends } = await sb.from("execution_log").select("contact_id").eq("location_id", LOC)
    .eq("action_type", "send_message").gte("created_at", "2026-09-25");
  const ids = [...new Set((sends || []).map((s) => (s as { contact_id: string }).contact_id))];

  let ok = 0, fail = 0;
  console.log(`Replay contra os ${ids.length} contatos reais abordados desde 25/09\n`);
  console.log("  tags                                     | gatilho velho | NOVO c/ 'agente financeiro' | esperado");
  for (const id of ids) {
    let tags: string[] = [], nome = "?";
    try { const c = await ghl.get<{ contact?: { tags?: string[]; firstName?: string } }>(`/contacts/${id}`, {}); tags = c.contact?.tags || []; nome = c.contact?.firstName || "?"; } catch { /* segue */ }
    const equipe = tags.some((t) => EQUIPE_E_CLIENTES.includes(t.toLowerCase()));
    // Exclusão isolada: força a ENTRADA com uma frase que casa e vê se a exclusão barra.
    const novo = await checkContactMatchesTargeting(id, NOVO_BRUNO, CO, LOC, { messageText: "quero saber sobre agente financeiro" });
    const certo = equipe ? !novo.ok : novo.ok;
    certo ? ok++ : fail++;
    console.log(`  ${certo ? "✅" : "❌"} ${nome.slice(0, 14).padEnd(14)} [${tags.join(",").slice(0, 34).padEnd(34)}] → ${novo.ok ? "PASSA" : "barra"}   (esperado: ${equipe ? "barra" : "passa"})`);
  }

  // Gatilho reativo velho: o campo de agendamento não pode mais ligar ninguém.
  console.log("\nO gatilho do campo de agendamento sumiu?");
  const temCampoAgendamento = (r: unknown) => JSON.stringify(r).includes("tUpk31fRxXs2bhxXYMh5");
  const semCampo = !temCampoAgendamento(NOVO_BRUNO) && !temCampoAgendamento(NOVO_BRUNA);
  console.log(`  ${semCampo ? "✅" : "❌"} nenhum dos dois agentes ativa por "Ultimo Agendamento"`);
  semCampo ? ok++ : fail++;

  console.log(`\nRESULTADO: ${ok} ok, ${fail} falhas`);
  if (fail) process.exit(1);

  if (!APPLY) { console.log("\n[replay] nada gravado. Use --apply."); return; }
  for (const [agente, regra, nome] of [[BRUNO, NOVO_BRUNO, "Bruno"], [BRUNA, NOVO_BRUNA, "Bruna"]] as const) {
    const { error } = await sb.from("agent_configs").update({ targeting_rules: regra }).eq("agent_id", agente);
    if (error) throw new Error(`${nome}: ${error.message}`);
    console.log(`✅ ${nome}: targeting gravado`);
  }
  const { data: st } = await sb.from("agents").select("name,status").in("id", [BRUNA, BRUNO]);
  console.log("status dos agentes (este script NÃO liga nem desliga):", JSON.stringify(st));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
