/**
 * Ajustes de config do agente de vendas da Márcia (H73, pedido dela 07/08):
 * a apresentação passa a ser no PLURAL ("Somos a Márcia e a Roberta") porque
 * qualquer uma das duas atende depois — o "eu sou a Marcia" prometia uma
 * pessoa só. Alinha também as custom_instructions, que voltaram a valer no
 * prompt (antes o system_prompt_override as matava em silêncio).
 *
 * Rodar: npx tsx scripts/apply-marcia-h73.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const L2_DE = "Você é a Marcia, da equipe Márcia e Roberta (especialistas em seguro";
const L2_PARA = "Você fala em nome da dupla: a Márcia e a Roberta (especialistas em seguro";
const APRES_DE = "Eu sou a Marcia, da equipe Márcia e Roberta — somos especialistas em seguro de vida com benefícios em vida aqui nos EUA.";
const APRES_PARA = "Somos a Márcia e a Roberta, especialistas em seguro de vida com benefícios em vida aqui nos EUA.";

// A regra antiga proibia citar a Roberta; a Márcia pediu o contrário na
// apresentação (qualquer uma das duas atende). O que continua valendo é não
// assinar como UMA delas.
const CUSTOM_DE = `Você atende em nome da equipe: a Márcia e a Roberta. Quando precisar se referir a quem atende, fale no plural ("a gente", "nosso time") ou "a Márcia e a Roberta". NUNCA assine a mensagem com um nome sozinho, NUNCA se apresente como "Rob" ou "Roberta", e NUNCA diga que é a Roberta falando. Ao encaminhar, diga que vai passar pra "a especialista" (feminino, é o time todo).`;
const CUSTOM_PARA = `Você atende em nome da dupla: a Márcia e a Roberta. Na apresentação, diga SEMPRE "Somos a Márcia e a Roberta" — as duas atendem, então nunca prometa uma pessoa específica. No resto da conversa fale no plural ("a gente", "nosso time"). NUNCA assine a mensagem com um nome sozinho, NUNCA diga "eu sou a Márcia" nem "eu sou a Roberta", e NUNCA diga que é uma delas falando. Ao encaminhar, diga que vai passar pra "a especialista" (feminino, vale pras duas).`;

async function main() {
  const { data } = await sb.from("agent_configs")
    .select("system_prompt_override,custom_instructions,personality").eq("agent_id", AGENT).single();
  const cfg = data as { system_prompt_override: string; custom_instructions: string; personality: Record<string, unknown> };

  let override = cfg.system_prompt_override;
  const trocas: string[] = [];
  for (const [de, para] of [[L2_DE, L2_PARA], [APRES_DE, APRES_PARA]] as const) {
    if (override.includes(de)) { override = override.split(de).join(para); trocas.push(de.slice(0, 45)); }
    else console.warn(`⚠️  não achei no override: "${de.slice(0, 45)}…"`);
  }
  // Sobra de "eu sou a Marcia" em qualquer variante do texto.
  const sobras = override.match(/eu sou a M[áa]rcia|sou a M[áa]rcia/gi) ?? [];

  const custom = cfg.custom_instructions.includes(CUSTOM_DE)
    ? cfg.custom_instructions.replace(CUSTOM_DE, CUSTOM_PARA)
    : cfg.custom_instructions;
  if (custom === cfg.custom_instructions) console.warn("⚠️  bloco QUEM ATENDE não bateu literal nas custom_instructions");

  const personality = {
    ...cfg.personality,
    name: "Márcia e Roberta",
    persona_description:
      "Primeiro contato da dupla Márcia e Roberta. Se apresenta no plural (\"Somos a Márcia e a Roberta\"), nunca assina com um nome sozinho. Coleta os 4 dados numa mensagem só e agenda com a especialista.",
  };

  console.log("trocas no override:", trocas.length, "| sobras de 1ª pessoa:", sobras);
  console.log("custom_instructions mudou:", custom !== cfg.custom_instructions);
  if (!APPLY) { console.log("\n(dry-run — rode com --apply)"); return; }

  const { error } = await sb.from("agent_configs")
    .update({ system_prompt_override: override, custom_instructions: custom, personality })
    .eq("agent_id", AGENT);
  console.log(error ? `❌ ${error.message}` : "✅ aplicado");
}
main();
