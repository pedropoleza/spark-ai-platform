/**
 * Conta da Márcia — tirar do toque #2 a promessa de enviar material.
 *
 * Queixa dela em 10/08: "A IA está oferecendo relatos que nunca foram enviados
 * ao cliente". O texto fixo do passo 2 dizia "Separei um relato de quem passou
 * por isso" — e o motor lead-facing não envia anexo em follow-up. Enquanto a
 * promessa estiver no texto configurado, o modelo copia (validado: 3 de 3
 * rodadas repetiam a promessa mesmo com a regra no prompt). Conserta-se na
 * fonte; a regra do prompt fica como rede pra próxima promessa que alguém
 * escrever.
 *
 * Rodar: npx tsx scripts/apply-marcia-followup-textos.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const DE = "Separei um relato de quem passou por isso, vamos marcar um horário?";
const PARA = "Vamos marcar um horário pra eu te explicar como se proteger disso?";

async function main() {
  const { data } = await sb.from("agent_configs").select("follow_up_config").eq("agent_id", AGENT).single();
  const cfg = (data as { follow_up_config: Record<string, unknown> }).follow_up_config;
  const passos = (cfg.manual_steps as Array<{ custom_message?: string; delay_minutes?: number }>) ?? [];

  let mudou = false;
  const novos = passos.map((p) => {
    const t = String(p.custom_message ?? "");
    if (t.includes(DE)) { mudou = true; return { ...p, custom_message: t.replace(DE, PARA) }; }
    return p;
  });

  console.log("passos:");
  novos.forEach((p, i) => console.log(`  #${i + 1} (${p.delay_minutes}min) "${String(p.custom_message ?? "").slice(0, 110)}"`));
  const aindaPromete = novos.filter((p) => /(separei|te envio|vou (te )?mandar|segue)\s+(um|o)?\s*(relato|v[íi]deo|material|print)/i.test(String(p.custom_message ?? "")));
  console.log(`\ntrocou: ${mudou} | passos que ainda prometem material: ${aindaPromete.length}`);
  if (!APPLY) { console.log("(dry-run — rode com --apply)"); return; }

  const { error } = await sb.from("agent_configs")
    .update({ follow_up_config: { ...cfg, manual_steps: novos } }).eq("agent_id", AGENT);
  console.log(error ? `❌ ${error.message}` : "✅ aplicado");
}
main();
