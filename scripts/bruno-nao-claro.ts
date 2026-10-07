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
 *   npx tsx scripts/bruno-nao-claro.ts           # mostra o diff
 *   npx tsx scripts/bruno-nao-claro.ts --apply   # grava
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

export const BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";

const VELHO_ENCERRA = "Sem fit e sem interesse: encerra educado.";
const NOVO_ENCERRA =
  "Sem fit: encerra educado.\n\n" +
  "NÃO CLARO = ENCERRA (v5 2026-10-07, caso Enaira, inviolável, vale acima de qualquer regra de reancorar): " +
  "quando o lead diz com clareza que não quer a oportunidade, que não é o que busca, que não é pra ele ou que não tem interesse " +
  "(\"não é o que eu busco no momento\", \"não tenho interesse\", \"não é pra mim\", \"não quero\"), você ACEITA na hora. " +
  "Agradece em 1 frase, deixa a porta aberta em 1 frase (\"se um dia fizer sentido, é só me chamar por aqui\") e encerra o turno com conversation_status \"disqualified\". " +
  "NÃO pergunta o motivo, NÃO pergunta o que ele imaginava, NÃO reapresenta a oportunidade, NÃO tenta esclarecer pra reconverter. " +
  "Se ele voltar a escrever só pra explicar, desabafar ou se despedir, responde curto e gentil, sem retomar o assunto e sem pergunta. " +
  "Só volta a falar da oportunidade se ELE perguntar por ela de novo. " +
  "Falta de tempo NÃO é não claro: \"agora não posso falar\", \"tô no trabalho\", \"me chama mais tarde\" é agenda, " +
  "e aí você combina outro momento sem encerrar.";

const VELHO_REANCORA = "\"Vou pensar\" ou recusa final de preço não é tchau:";
const NOVO_REANCORA = "\"Vou pensar\" ou recusa final de preço (hesitação, NUNCA um não claro, que encerra pela regra NÃO CLARO) não é tchau:";

export function aplicar(ci: string): string {
  if (!ci.includes(VELHO_ENCERRA)) throw new Error("trecho de encerramento não encontrado — prompt mudou, revisar à mão");
  if (!ci.includes(VELHO_REANCORA)) throw new Error("trecho de reancorar não encontrado — prompt mudou, revisar à mão");
  return ci.replace(VELHO_ENCERRA, NOVO_ENCERRA).replace(VELHO_REANCORA, NOVO_REANCORA);
}

if (require.main === module) {
  (async () => {
    const sb = createAdminClient();
    const { data } = await sb.from("agent_configs").select("custom_instructions").eq("agent_id", BRUNO).single();
    const ci = String((data as { custom_instructions: string }).custom_instructions || "");
    if (ci.includes("NÃO CLARO = ENCERRA")) { console.log("já aplicado — nada a fazer"); return; }
    const novo = aplicar(ci);
    console.log(`prompt: ${ci.length} → ${novo.length} chars\n+ ${NOVO_ENCERRA}\n~ ${NOVO_REANCORA}`);
    if (!process.argv.includes("--apply")) { console.log("\n[dry-run] use --apply"); return; }
    const { error } = await sb.from("agent_configs").update({ custom_instructions: novo }).eq("agent_id", BRUNO);
    if (error) throw new Error(error.message);
    console.log("\n✅ gravado");
  })().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
