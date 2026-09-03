/**
 * Conta da Márcia (jA6uzx6tONyTeocxw4Cj) — queixas de 01-03/09.
 *
 * Liga o `suppress_ad_context_turn` (H61), que existe desde 01/08 e foi escrito
 * PARA esta conta, mas estava desligado. Com ele, o turno do clique no anúncio
 * roda com instrução determinística de NÃO se apresentar, NÃO explicar o produto
 * e NÃO repetir o pedido de dados — porque quem faz a entrada aqui é o workflow
 * "Incoming Lead > Message - v81". Era a origem da queixa "chegando 7 mensagens
 * pros clientes e a mensagem onde pedimos os dados está duplicada" (medido: 2 de
 * 25 leads novos com o pedido duplicado, 8 e 12 mensagens em 10 minutos).
 *
 * Não desliga o workflow (isso é decisão do dono da conta, no painel) e não cala
 * a IA: se o lead digitou pergunta própria no anúncio, ela responde só àquilo.
 *
 * Rodar: npx tsx scripts/apply-marcia-set-2026-09.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await sb.from("agent_configs")
    .select("suppress_ad_context_turn,entry_by_automation").eq("agent_id", AGENT).single();
  console.log("antes:", JSON.stringify(data));
  if (!APPLY) { console.log("(dry-run — rode com --apply)"); return; }
  const { error } = await sb.from("agent_configs")
    .update({ suppress_ad_context_turn: true }).eq("agent_id", AGENT);
  const { data: depois } = await sb.from("agent_configs")
    .select("suppress_ad_context_turn").eq("agent_id", AGENT).single();
  console.log(error ? `❌ ${error.message}` : `✅ suppress_ad_context_turn = ${(depois as {suppress_ad_context_turn?:boolean})?.suppress_ad_context_turn}`);
}
main();
