/**
 * Hardening do prompt da Bianca a partir dos achados da simulação (5 conversas
 * turno-a-turno, 2026-06-18). 3 P0/P1 pegos pelos juízes:
 *   1. VAZOU token cru ({{LINK_NATIONAL_life}}) pro cético + disse "o link já tá
 *      na conversa" sem ter mandado nada → REGRA DE LINK inviolável (nunca digita
 *      chaves {{ }}; nunca afirma link enviado sem link real).
 *   2. Repetiu a MESMA pergunta-ouro 2x e o lead percebeu o roteiro ("você fica
 *      me redirecionando") → trava anti-repetição da pergunta-ouro.
 *   3. Toque do time virou promessa de canal específico ("no WhatsApp") →
 *      afrouxa pra "o time te dá um toque" sem garantir canal/horário.
 *
 * Idempotente. NÃO mexe em comportamento aprovado (rapport/compliance seguraram).
 *   npx tsx -r tsconfig-paths/register scripts/patch-bianca-prompt-hardening.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const BIANCA_AGENT = "17860a86-ace9-4299-9328-2452151348a0";

const ANCHOR_CANAL =
  "- A janela do IG fecha em ~24h. Por isso: mande o link da reunião AGORA na própria DM e, pro lembrete fora-de-IG, alguém do time toca a pessoa (ver BLOCO REUNIÃO). NUNCA prometa que VOCÊ vai mandar lembrete por email/WhatsApp depois — o canal não entrega isso.";

const REGRA_LINK =
  "\n\n# REGRA DE LINK (inviolável — vale pra QUALQUER link)\n" +
  "Você SÓ envia uma URL se ela for um link real e COMPLETO presente no contexto. Você NUNCA digita chaves duplas { } numa mensagem — isso é placeholder de SISTEMA, não é link; mandar isso entrega na hora que você é automação e DETONA o cético. Se você NÃO tem um link real pra mandar: NUNCA diga que \"mandou o link\", que \"o link já tá na conversa\", que \"tá salvo aqui em cima\" nem nada que afirme um envio que não aconteceu. Em vez disso, diga que o time te envia o link oficial agora e faça a ponte (handoff). Afirmar um link que não foi enviado é mentira que o cético percebe na hora.";

const ANCHOR_OURO =
  'A pergunta que abre a emoção é: "o que mais te chamou atenção no anúncio / no conteúdo da Bianca?". Use como gancho emocional central, não como formulário.';

const OURO_ANTIREPEAT =
  " NUNCA repita a MESMA pergunta-ouro que já fez na conversa. Se já perguntou, AVANCE no funil. Ficar redirecionando pra mesma pergunta (ainda mais quando o lead cobra uma resposta direta) faz o lead perceber o roteiro na hora — foi exatamente isso que queimou numa simulação ('você fica me redirecionando').";

const ANCHOR_STEP5 =
  '5. LEMBRETE (honesto, sem prometer canal que não entrega): como a janela do IG fecha em ~24h, NÃO diga "vou te mandar por email e WhatsApp". Em vez disso: "como aqui no IG a janela fecha, já deixei teu link salvo nessa conversa ☺️ e alguém do time vai te dar um toque antes pra você não perder". (O lembrete fora-de-IG é feito pelo time via handoff — você não promete um disparo seu.)';

const STEP5_NEW =
  '5. LEMBRETE (honesto, sem prometer canal que não entrega): como a janela do IG fecha em ~24h, NÃO diga "vou te mandar por email e WhatsApp". Diga, SEM garantir canal nem horário exato: "o time vai te dar um toque antes da reunião pra confirmar tudo com você ☺️". NÃO prometa "no WhatsApp/por email" nem hora certa do toque. Só diga que o link "tá salvo na conversa" se você REALMENTE enviou um link real (ver REGRA DE LINK); se não enviou, não diga isso. (O toque fora-de-IG é feito pelo time via handoff — você não promete um disparo seu.)';

async function main() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_configs")
    .select("custom_instructions")
    .eq("agent_id", BIANCA_AGENT)
    .single();
  if (error || !data) throw new Error("load: " + (error?.message || "sem config"));

  let p: string = data.custom_instructions;
  const before = p.length;
  const applied: string[] = [];

  if (p.includes("# REGRA DE LINK")) {
    console.log("• REGRA DE LINK já presente — pulando #1");
  } else if (p.includes(ANCHOR_CANAL)) {
    p = p.replace(ANCHOR_CANAL, ANCHOR_CANAL + REGRA_LINK);
    applied.push("#1 REGRA DE LINK (anti-token-cru + anti-link-fantasma)");
  } else {
    throw new Error("âncora CANAL não encontrada — prompt mudou; revisar manualmente");
  }

  if (p.includes("NUNCA repita a MESMA pergunta-ouro")) {
    console.log("• anti-repeat pergunta-ouro já presente — pulando #2");
  } else if (p.includes(ANCHOR_OURO)) {
    p = p.replace(ANCHOR_OURO, ANCHOR_OURO + OURO_ANTIREPEAT);
    applied.push("#2 trava anti-repetição da pergunta-ouro");
  } else {
    throw new Error("âncora PERGUNTA-OURO não encontrada");
  }

  if (p.includes('o time vai te dar um toque antes da reunião pra confirmar tudo')) {
    console.log("• step 5 já ajustado — pulando #3");
  } else if (p.includes(ANCHOR_STEP5)) {
    p = p.replace(ANCHOR_STEP5, STEP5_NEW);
    applied.push("#3 toque do time sem prometer canal/horário");
  } else {
    throw new Error("âncora STEP5 não encontrada");
  }

  if (applied.length === 0) {
    console.log("Nada a aplicar (já estava tudo patchado).");
    process.exit(0);
  }

  const { error: ue } = await supabase
    .from("agent_configs")
    .update({ custom_instructions: p })
    .eq("agent_id", BIANCA_AGENT);
  if (ue) throw new Error("update: " + ue.message);

  console.log(`✅ Bianca patchada (${before} → ${p.length} chars):`);
  applied.forEach((a) => console.log("   - " + a));
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
