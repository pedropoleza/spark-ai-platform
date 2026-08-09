/**
 * Conta da Márcia — o custom_prompt do follow-up mandava a IA ficar CALADA na
 * única situação em que um follow-up existe.
 *
 * Texto antigo: "Se a última mensagem da conversa foi NOSSA e nada mudou desde
 * o último toque, use SÓ o marcador [[NAO_ENVIAR]]". Todo follow-up roda
 * exatamente nessa condição (falamos, o lead não respondeu, nada mudou) — então
 * a instrução desligava o recurso inteiro. Resultado: 29 de 981 follow-ups
 * entregues desde 26/07 (3%), contra 16% numa conta comparável.
 *
 * Rodar: npx tsx scripts/apply-marcia-followup.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const NOVO_PROMPT =
  "Follow-up desta conta é CURTO (1-2 frases) e serve só pra retomar: nunca re-explicar o produto, " +
  "nunca re-listar os dados. O lead não ter respondido é o MOTIVO do toque, não motivo pra ficar " +
  "quieto. Só use [[NAO_ENVIAR]] se ele adiou pra uma data futura, recusou, pediu humano ou já está " +
  "agendado. Varie o texto a cada toque.";

async function main() {
  const { data } = await sb.from("agent_configs").select("follow_up_config").eq("agent_id", AGENT).single();
  const cfg = (data as { follow_up_config: Record<string, unknown> }).follow_up_config;
  console.log("custom_prompt ANTES:\n ", cfg.custom_prompt);
  const novo = { ...cfg, custom_prompt: NOVO_PROMPT };
  console.log("\ncustom_prompt DEPOIS:\n ", NOVO_PROMPT);
  if (!APPLY) { console.log("\n(dry-run — rode com --apply)"); return; }
  const { error } = await sb.from("agent_configs").update({ follow_up_config: novo }).eq("agent_id", AGENT);
  console.log(error ? `❌ ${error.message}` : "✅ aplicado");
}
main();
