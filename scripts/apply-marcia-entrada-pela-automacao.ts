/**
 * Conta da Márcia — entrada pela AUTOMAÇÃO (decisão do Pedro, 03/09):
 * o workflow "Incoming Lead > Message - v81" cumprimenta, manda o áudio, pede
 * os dados e adiciona a tag `AI qualification active`; a IA entra na resposta
 * do lead. Três ajustes de config, nesta ordem:
 *
 * 1. Targeting só por TAG. Hoje é "frase OU tag": a frase do anúncio ("Veio de
 *    anúncio", "Quero entender como funciona o seguro") ativava a IA no clique,
 *    em paralelo com o workflow — as "7 mensagens" da queixa.
 * 2. Sai a automação `abertura-audio` da IA: o workflow já manda o "Audio 1".
 *    Com as duas, o lead recebia o áudio duas vezes.
 * 3. Prompt de entrada reescrito: a IA NUNCA se apresenta, NUNCA repete o
 *    bloco dos 4 dados, NUNCA promete áudio — ela continua de onde a automação
 *    parou.
 * (entry_by_automation e suppress_ad_context_turn ficam true.)
 *
 * Rodar: npx tsx scripts/apply-marcia-entrada-pela-automacao.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ENTRADA_DE_INICIO = "A 1ª mensagem do lead geralmente é o clique no anúncio";
const ENTRADA_ATE = "Se o lead chegou perguntando algo específico (digitou a própria pergunta), responda a pergunta PRIMEIRO (curto), e aí siga a abertura.";
const ENTRADA_NOVA = `QUEM ABRE A CONVERSA É A AUTOMAÇÃO, NÃO VOCÊ. Quando o lead chega (clique no anúncio ou primeira mensagem), o sistema já manda: a saudação em nome da Márcia e da Roberta, o áudio da Márcia explicando o benefício em vida, e o bloco pedindo os 4 dados (nome e sobrenome, data de nascimento, estado, fumante) com a linha do cônjuge. Você só entra quando o lead RESPONDE a isso.

Por isso, na sua PRIMEIRA mensagem e em todas as outras:
- NUNCA se apresente ("Somos a Márcia e a Roberta", "Que bom que você chegou") e NUNCA explique o que é o seguro como abertura — isso já foi feito.
- NUNCA repita o bloco dos 4 dados por inteiro. Se o lead mandou tudo, agradeça em 1 linha e vá pro próximo passo (cônjuge, se for casado; senão, agendamento). Se mandou parte, cobre SÓ o que faltou, numa linha. Se respondeu sem dado nenhum ("oi", "ok", uma pergunta), responda ao que ele disse e peça os dados em UMA linha curta, sem lista.
- NUNCA prometa áudio ("tô te mandando um audiozinho"): o áudio já foi enviado pela automação. Se o lead perguntar "que áudio?", diga que é a mensagem de voz logo acima.
- Se o lead chegou com uma pergunta própria, responda a pergunta PRIMEIRO (curto) e só então peça o que falta.`;

async function main() {
  const { data } = await sb.from("agent_configs")
    .select("targeting_rules,automations,system_prompt_override,entry_by_automation,suppress_ad_context_turn")
    .eq("agent_id", AGENT).single();
  const cfg = data as {
    targeting_rules: { match: string; groups: Array<{ id: string; rules: unknown[] }>; version: number };
    automations: Array<{ id: string }>;
    system_prompt_override: string;
    entry_by_automation: boolean; suppress_ad_context_turn: boolean;
  };

  // 1) targeting só por tag
  const grupos = cfg.targeting_rules.groups;
  const soTag = grupos.filter((g) => g.id === "g-tag");
  console.log(`targeting: ${grupos.map((g) => g.id).join(" OU ")} → ${soTag.map((g) => g.id).join(" OU ")}`);
  if (soTag.length !== 1) throw new Error("esperava exatamente o grupo g-tag");
  const targeting = { ...cfg.targeting_rules, groups: soTag };

  // 2) sem abertura-audio
  const removida = cfg.automations.find((a) => a.id === "abertura-audio");
  const automations = cfg.automations.filter((a) => a.id !== "abertura-audio");
  console.log(`automações: ${cfg.automations.length} → ${automations.length} (removida: ${removida ? "abertura-audio" : "nenhuma"})`);
  if (removida) console.log("   (pra reverter) ", JSON.stringify(removida));

  // 3) prompt de entrada
  const p = cfg.system_prompt_override;
  const i0 = p.indexOf(ENTRADA_DE_INICIO);
  const i1 = p.indexOf(ENTRADA_ATE);
  if (i0 < 0 || i1 < 0) throw new Error("não achei a seção de entrada no prompt");
  const prompt = p.slice(0, i0) + ENTRADA_NOVA + p.slice(i1 + ENTRADA_ATE.length);
  const sobras = prompt.match(/audiozinho|Sua 1ª resposta são 2 mensagens|Apresentação \+ resumo/g) ?? [];
  console.log(`prompt: ${p.length} → ${prompt.length} chars | sobras da entrada antiga: ${sobras.length}`);

  console.log(`flags: entry_by_automation=${cfg.entry_by_automation} suppress_ad_context_turn=${cfg.suppress_ad_context_turn}`);
  if (!APPLY) { console.log("(dry-run — rode com --apply)"); return; }
  const { error } = await sb.from("agent_configs").update({
    targeting_rules: targeting, automations, system_prompt_override: prompt,
    entry_by_automation: true, suppress_ad_context_turn: true,
  }).eq("agent_id", AGENT);
  console.log(error ? `❌ ${error.message}` : "✅ aplicado");
}
main().catch((e) => { console.error("❌", e.message); process.exit(1); });
