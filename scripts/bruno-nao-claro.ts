/**
 * Bruno (Alves Cury) — aceitar um NÃO claro (caso Enaira, 07/10/2026, prometido
 * ao Marcos pra 08/10 9h05). A regra "'Vou pensar' ou recusa ... não é tchau:
 * reancore" vinha de vendas e ganhava do "Sem interesse: encerra educado";
 * "não é o que eu busco" + "imaginei que era outra coisa" foi lido como confusão
 * a esclarecer, e o Bruno insistiu 2x.
 *
 * `disqualified` é o que faz o follow-up parar (completedStatuses no scheduler)
 * — encerrar só no texto deixaria os toques saindo.
 *
 * v5.1 (08/10): a v5 tinha dois defeitos que o replay no Sonnet mostrou.
 *  1. Empurrava as custom_instructions pra 16.135 chars, acima do teto de 16.000
 *     do sales-prompt-builder: o corte comia o FIM da regra anti-repetição
 *     ("Refez 1x sem resposta? Siga o fluxo sem esse dado..."). Regra nova não
 *     pode custar regra velha — mantenha folga.
 *  2. Quando o lead voltava com "me confundi, achei que era curso", o Bruno
 *     explicava a oportunidade de novo (o 2º episódio real, 11h03). A v5.1 diz
 *     com todas as letras que isso é o lead EXPLICANDO o não.
 *
 *   npx tsx scripts/bruno-nao-claro.ts           # mostra o que faria
 *   npx tsx scripts/bruno-nao-claro.ts --apply   # grava
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

export const BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";
/** Teto do sales-prompt-builder (CUSTOM_INSTRUCTIONS_CAP). Medido em UTF-16, como o JS corta. */
export const TETO = 16000;
export const MARCA_V51 = "NÃO CLARO = ENCERRA (v5.1";

const REGRA_V51 =
  "NÃO CLARO = ENCERRA (v5.1 08/10/2026, caso Enaira, acima de qualquer regra de reancorar): lead disse que não quer, " +
  "que não é o que busca, que não é pra ele ou que não tem interesse? ACEITE: agradeça e deixe a porta aberta, 1 frase cada, " +
  "sem pergunta, e marque conversation_status \"disqualified\". Não pergunte motivo nem o que ele imaginava, não reapresente " +
  "a oportunidade. Se ele voltar dizendo que se confundiu, que imaginou outra coisa ou que achou que era curso, ele está " +
  "explicando o não: 1 frase gentil, sem explicar a oportunidade, sem pergunta. Só retome se ELE perguntar. " +
  "Falta de tempo (\"agora não posso\", \"tô no trabalho\") não é recusa: combine outro momento.";

// Estado original (antes de 07/10).
const ORIG_ENCERRA = "Sem fit e sem interesse: encerra educado.";
const ORIG_REANCORA = "\"Vou pensar\" ou recusa final de preço não é tchau:";
// Estado v5 (gravado em 07/10 ~22:50 UTC).
const V5_INICIO = "NÃO CLARO = ENCERRA (v5 2026-10-07";
const V5_REANCORA = "\"Vou pensar\" ou recusa final de preço (hesitação, NUNCA um não claro, que encerra pela regra NÃO CLARO) não é tchau:";

const NOVO_ENCERRA = "Sem fit: encerra educado.\n\n" + REGRA_V51;
const NOVO_REANCORA = "\"Vou pensar\" ou recusa final de preço (hesitação, não um não claro) não é tchau:";

/** Leva o prompt (original OU v5) pra v5.1. Recusa se não reconhecer o estado. */
export function aplicar(ci: string): string {
  let out = ci;
  if (out.includes(V5_INICIO)) {
    const i = out.indexOf(V5_INICIO);
    const fim = out.indexOf("\n", i);
    out = out.slice(0, i) + REGRA_V51 + (fim === -1 ? "" : out.slice(fim));
  } else if (out.includes(ORIG_ENCERRA)) {
    out = out.replace(ORIG_ENCERRA, NOVO_ENCERRA);
  } else {
    throw new Error("trecho de encerramento não encontrado — prompt mudou, revisar à mão");
  }
  if (out.includes(V5_REANCORA)) out = out.replace(V5_REANCORA, NOVO_REANCORA);
  else if (out.includes(ORIG_REANCORA)) out = out.replace(ORIG_REANCORA, NOVO_REANCORA);
  else throw new Error("trecho de reancorar não encontrado — prompt mudou, revisar à mão");
  if (out.length > TETO) throw new Error(`prompt ficaria com ${out.length} chars, acima do teto de ${TETO}: o fim seria cortado`);
  return out;
}

if (require.main === module) {
  (async () => {
    const sb = createAdminClient();
    const { data } = await sb.from("agent_configs").select("custom_instructions").eq("agent_id", BRUNO).single();
    const ci = String((data as { custom_instructions: string }).custom_instructions || "");
    if (ci.includes(MARCA_V51)) { console.log(`já está na v5.1 (${ci.length} chars, folga ${TETO - ci.length}) — nada a fazer`); return; }
    const novo = aplicar(ci);
    console.log(`prompt: ${ci.length} → ${novo.length} chars (teto ${TETO}, folga ${TETO - novo.length})\n+ ${REGRA_V51}\n~ ${NOVO_REANCORA}`);
    if (!process.argv.includes("--apply")) { console.log("\n[dry-run] use --apply"); return; }
    const { error } = await sb.from("agent_configs").update({ custom_instructions: novo }).eq("agent_id", BRUNO);
    if (error) throw new Error(error.message);
    console.log("\n✅ gravado");
  })().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
