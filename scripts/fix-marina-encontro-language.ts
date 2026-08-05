/**
 * fix-marina-encontro-language.ts
 *
 * Fix cirúrgico — 3 comportamentos reportados pela Marina (2026-07-01):
 *   1. Bot usava "ligação" (parece chamada de tel/WhatsApp) → deve ser "encontro"
 *   2. Bot minimizava o encontro ("só 20 minutos", "do carro", "rapidinho") → proibir
 *   3. Bot disse "empresa com mais de 100 anos" → o bloco PROVA PRO CÉTICO já bloqueava
 *      "X anos"/"desde 18xx" mas não a forma "mais de X anos" — reforçar explicitamente
 *
 * Idempotente — pula se já estiver aplicado.
 *   npx tsx -r tsconfig-paths/register scripts/fix-marina-encontro-language.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const MARINA = "3976b4b6-0345-4f25-b964-138bb7960058";

const FIXES: Array<{ label: string; old: string; new: string }> = [
  {
    label: "BLOCO ENCONTRO — proibir 'ligação', 'carro', 'rapidinho'",
    // Fix compacto: adiciona ~45 chars líquidos (margem é curta, prompt está em 7987/8000)
    old: `Diga "encontro", NUNCA "turma". NÃO diga quais dias da semana "normalmente" tem — só os dias da lista.`,
    new: `Diga "encontro", NUNCA "turma"/"ligação" e proibido carro/"rapidinho". NÃO diga quais dias da semana "normalmente" tem — só os dias da lista.`,
  },
  {
    label: "PROVA PRO CÉTICO — compactar + bloquear 'mais de X anos'",
    // Substitui frase longa por versão mais curta que inclui o fix de 'mais de X anos'
    // Net: economiza ~40 chars, compensando a adição do fix 1
    old: `você não tem link pra mandar e NÃO revela o nome da empresa/seguradora/distribuidora parceira nem ano de fundação ("X anos"/"desde 18xx"); "já peço pro time te mandar o material oficial com o nome e tudo 🙂" + handoff. NUNCA escreva chaves { } nem invente URL.`,
    new: `NÃO revela nome da empresa/parceira nem fundação/idade ("X anos"/"desde 18xx"/"mais de X anos"); "já peço pro time te mandar o material oficial com o nome e tudo 🙂" + handoff. NUNCA escreva chaves { } nem invente URL.`,
  },
];

async function main() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_configs")
    .select("custom_instructions")
    .eq("agent_id", MARINA)
    .single();

  if (error || !data) throw new Error("load: " + (error?.message ?? "sem config"));

  let prompt: string = data.custom_instructions;
  const before = prompt.length;
  let applied = 0;
  let alreadyOk = 0;
  let notFound = 0;

  for (const fix of FIXES) {
    if (prompt.includes(fix.new)) {
      console.log(`• já OK: ${fix.label}`);
      alreadyOk++;
      continue;
    }
    if (!prompt.includes(fix.old)) {
      console.warn(`⚠️  âncora não encontrada: ${fix.label}`);
      console.warn(`   Buscando: "${fix.old.slice(0, 80)}…"`);
      notFound++;
      continue;
    }
    prompt = prompt.replace(fix.old, fix.new);
    console.log(`✅ aplicado: ${fix.label}`);
    applied++;
  }

  if (applied === 0) {
    console.log(`\nNada a aplicar. ${alreadyOk} já OK, ${notFound} âncoras não encontradas.`);
    process.exit(notFound > 0 ? 1 : 0);
  }

  if (prompt.length > 8000) {
    throw new Error(`Prompt ficou ${prompt.length} chars (>8000). Abortar.`);
  }

  const { error: ue } = await supabase
    .from("agent_configs")
    .update({ custom_instructions: prompt })
    .eq("agent_id", MARINA);

  if (ue) throw new Error("update: " + ue.message);

  console.log(`\n✅ ${applied} fix(es) aplicado(s). Prompt: ${before} → ${prompt.length} chars.`);
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
