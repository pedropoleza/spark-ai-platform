/**
 * Conta da Márcia (jA6uzx6tONyTeocxw4Cj) — coleta em BLOCO + dados do cônjuge.
 *
 * Pedido dela em 07/08: "Preciso que vocês configurem a IA para solicitar
 * também as informações do cônjuge quando a pessoa informar que é casada" —
 * junto com o exemplo do bloco de dados que a equipe mandava à mão.
 *
 * No caminho apareceu uma contradição que explicava parte da queixa "a gente
 * manda e nada muda": o `system_prompt_override` mandava pedir UM DADO POR VEZ
 * e as `custom_instructions` mandavam pedir OS 4 JUNTOS. Como o override
 * anulava as custom_instructions em silêncio (corrigido no H73), valia o
 * "um por vez" — o oposto do que ela pediu. Aqui as duas fontes passam a dizer
 * a mesma coisa: bloco único, e cônjuge quando a pessoa se declara casada.
 *
 * Rodar: npx tsx scripts/apply-marcia-coleta-conjuge.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const L13_DE = `2. Já engate o 1º dado: "Enquanto isso, pra eu adiantar sua cotação: qual sua data de nascimento? Mês, dia e ano (ex.: maio, 21, 1994)"`;
const L13_PARA = `2. Já peça os dados da cotação, todos numa mensagem só (ver COLETA DE DADOS abaixo).`;

const SECAO_DE = `COLETA DE DADOS — UM DADO POR VEZ (nunca em bloco)
============================================================
Pra cotação você precisa de: data de nascimento, estado onde mora e se é fumante. O nome geralmente já vem do cadastro — NÃO fique pedindo sobrenome à toa.
- Peça UM dado por mensagem, nesta ordem: 1º data de nascimento → 2º estado → 3º fumante.
- NUNCA mande a lista inteira de dados de uma vez (bloco gigante afasta o lead).`;

const SECAO_PARA = `COLETA DE DADOS — OS 4 NUMA MENSAGEM SÓ (nunca picado)
============================================================
Pra cotação você precisa de: nome e sobrenome, data de nascimento, estado onde mora e se é fumante.
- Peça os 4 JUNTOS, numa lista curta, nesta ordem exata. NUNCA peça um dado por vez: chega picado do outro lado e a equipe perde a informação (principalmente o fumante).
- Modelo do pedido (adapte o texto, mantenha a lista):
  "O valor muda de pessoa pra pessoa — depende da idade, se fuma e do valor da proteção. Me passa esses dados?
  • Nome e sobrenome
  • Data de nascimento (mês, dia e ano — ex.: maio, 21, 1994)
  • Estado onde mora
  • É fumante? (sim/não)
  Se for casado(a), manda os dados do seu cônjuge também 🙂"
- CÔNJUGE: se a pessoa disser que é casada (ou citar marido/esposa/cônjuge) em QUALQUER momento, peça os dados dele(a) na mesma hora — nome e sobrenome, data de nascimento e se é fumante (o estado é o mesmo, não repergunte). É a cotação do casal; sem isso a equipe fica sem metade do trabalho. Se a pessoa não quiser passar, siga normalmente e NÃO insista.
- Se ela responder só uma parte, agradeça e cobre APENAS o que faltou — de novo tudo junto numa mensagem só.`;

const CUSTOM_DE = `Os 4 dados vão TODOS NA MESMA MENSAGEM, nesta ordem exata, numa lista curta:
1. primeiro e último nome
2. data de nascimento
3. estado onde mora
4. se é fumante ou não`;

const CUSTOM_PARA = `Os 4 dados vão TODOS NA MESMA MENSAGEM, nesta ordem exata, numa lista curta:
1. primeiro e último nome
2. data de nascimento
3. estado onde mora
4. se é fumante ou não

E feche o pedido com "Se for casado(a), manda os dados do seu cônjuge também". Quando a pessoa disser que é casada (ou citar marido/esposa) em qualquer ponto da conversa, peça na hora nome e sobrenome, data de nascimento e se é fumante do cônjuge — o estado é o mesmo. Se ela não quiser passar, siga sem insistir.`;

async function main() {
  const { data } = await sb.from("agent_configs")
    .select("system_prompt_override,custom_instructions").eq("agent_id", AGENT).single();
  const cfg = data as { system_prompt_override: string; custom_instructions: string };

  let override = cfg.system_prompt_override;
  for (const [de, para] of [[L13_DE, L13_PARA], [SECAO_DE, SECAO_PARA]] as const) {
    if (override.includes(de)) override = override.split(de).join(para);
    else console.warn(`⚠️  não bateu literal no override: "${de.slice(0, 55)}…"`);
  }
  const custom = cfg.custom_instructions.includes(CUSTOM_DE)
    ? cfg.custom_instructions.replace(CUSTOM_DE, CUSTOM_PARA)
    : cfg.custom_instructions;
  if (custom === cfg.custom_instructions) console.warn("⚠️  bloco dos 4 dados não bateu nas custom_instructions");

  console.log("override mudou:", override !== cfg.system_prompt_override);
  console.log("custom_instructions mudou:", custom !== cfg.custom_instructions);
  console.log("sobrou 'UM DADO POR VEZ' no override:", /um dado por vez/i.test(override));
  console.log("cita cônjuge — override:", /c[ôo]njuge/i.test(override), "| custom:", /c[ôo]njuge/i.test(custom));
  if (!APPLY) { console.log("\n(dry-run — rode com --apply)"); return; }

  const { error } = await sb.from("agent_configs")
    .update({ system_prompt_override: override, custom_instructions: custom }).eq("agent_id", AGENT);
  console.log(error ? `❌ ${error.message}` : "✅ aplicado");
}
main();
