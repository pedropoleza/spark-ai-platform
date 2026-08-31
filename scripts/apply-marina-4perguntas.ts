/**
 * Recoloca a lista das 4 perguntas do pós-encontro no agente da Marina (POS).
 *
 * POR QUÊ: na compactação de 26/08 (pra caber no teto de 8000 do
 * custom_instructions) eu removi o bloco "# AS 4 PERGUNTAS". Sobrou a regra
 * "espere as 4 e peça a que falta" — mas sem a lista, o agente não sabe QUAL
 * falta. Isso vira bloqueante agora que o template do WhatsApp vai deixar de
 * mandar a pergunta do investimento (ela dispara a categoria MARKETING da Meta:
 * "utility cannot include offers").
 *
 * ONDE: `knowledge_base_instructions`, que estava VAZIO, é lido pelo prompt
 * (buildKnowledgeBaseSection) e tem cap de 12000 — ou seja, não disputa espaço
 * com o custom_instructions, que está em 7977/8000.
 *
 *   npx tsx scripts/apply-marina-4perguntas.ts [--dry] [--revert]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const POS = "d4894e2a-43fa-4b2f-8949-0bbd941be2b9";
const REVERT = process.argv.includes("--revert");
const DRY = process.argv.includes("--dry");

const TEXTO = `# AS 4 PERGUNTAS DO PÓS-ENCONTRO (referência — você NÃO as reenvia em bloco)
Depois do encontro, a pessoa recebe uma mensagem automática com estas perguntas:
1. Por que essa carreira e ser treinada por nós é a oportunidade ideal pra você?
2. Entre todas as pessoas interessadas, por que eu deveria escolher você?
3. Você tem condições de fazer o investimento inicial no treinamento agora?
4. O que precisa acontecer no primeiro ano pra você dizer que foi a melhor decisão?

A mensagem automática NÃO inclui a pergunta 3 nem cita valor — quem faz essa é VOCÊ, com naturalidade, depois que ela já tiver começado a responder as outras. Nunca de cara. O valor (89 dólares) só entra se ELA perguntar quanto é, ou na hora de conduzir ao registro.

COMO PEDIR O QUE FALTA (regra dura): NUNCA se refira a uma pergunta pelo NÚMERO ("me falta a pergunta 3") — ela não numerou nada e pode nem ter visto essa pergunta. ESCREVA A PERGUNTA POR EXTENSO, do seu jeito, no meio da conversa.
Considere uma pergunta RESPONDIDA se ela tocou no assunto, mesmo em uma frase curta — não exija resposta formal nem re-peça o que ela já disse com outras palavras.`;

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();
  const { data } = await sb
    .from("agent_configs").select("knowledge_base_instructions").eq("agent_id", POS).single();
  const atual = (data?.knowledge_base_instructions || "") as string;

  const novo = REVERT ? "" : TEXTO;
  console.log(`knowledge_base_instructions: ${atual.length} → ${novo.length} chars`);
  if (DRY) { console.log("[dry] nada gravado"); process.exit(0); }

  const { error } = await sb
    .from("agent_configs")
    .update({ knowledge_base_instructions: novo, updated_at: new Date().toISOString() })
    .eq("agent_id", POS);
  if (error) throw new Error(error.message);

  const { data: conf } = await sb
    .from("agent_configs").select("knowledge_base_instructions, custom_instructions").eq("agent_id", POS).single();
  const kb = conf?.knowledge_base_instructions || "";
  console.log(`confirmado: ${kb.includes("AS 4 PERGUNTAS") !== REVERT ? "✅" : "❌"}`);
  console.log(`custom_instructions segue em ${(conf?.custom_instructions || "").length}/8000 (intocado)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
