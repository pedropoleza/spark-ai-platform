/**
 * 2 ajustes finos da Bianca pós re-simulação 1:1 (2026-06-18):
 *  1. Booking: a Manu dizia "tá alinhado / o link vem junto" SEM ter fixado um
 *     horário concreto (dia+hora). Reforça: sem dia+hora confirmado, não afirma
 *     "alinhado/marcado/tudo certo".
 *  2. Anti-eco: quando o lead desvia/ignora/devolve a pergunta-ouro, a Manu
 *     repetia a mesma pergunta (loop percebido como roteiro). Reforça: não
 *     insiste na mesma pergunta — reflete e segue.
 * Mantém <8000. Idempotente.
 *   npx tsx -r tsconfig-paths/register scripts/patch-bianca-sim2.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const BIANCA_AGENT = "17860a86-ace9-4299-9328-2452151348a0";

const REPLACEMENTS: [string, string][] = [
  [
    'Sem horário confirmado, NÃO afirme reserva: "te passo os horários que a Bianca tem e o link vem junto da confirmação".',
    'Sem dia+hora CONCRETO confirmado, NÃO afirme reserva nem diga "tá alinhado/marcado/o link vem junto": diga "te passo os horários da Bianca e a confirmação chega com o link".',
  ],
  [
    "Ficar redirecionando pra mesma pergunta (ainda mais quando o lead cobra resposta direta) faz o lead perceber o roteiro.",
    "Se o lead desviou, ignorou ou devolveu a pergunta, NÃO insista nela: reflita o que ele trouxe e SIGA (avança o funil ou reage). Repetir a mesma pergunta 2x faz o lead perceber o roteiro na hora.",
  ],
];

async function main() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_configs").select("custom_instructions").eq("agent_id", BIANCA_AGENT).single();
  if (error || !data) throw new Error("load: " + (error?.message || "sem config"));

  let p: string = data.custom_instructions;
  const before = p.length;
  let n = 0;
  for (const [oldS, newS] of REPLACEMENTS) {
    if (p.includes(newS)) { console.log("• já aplicado"); continue; }
    if (!p.includes(oldS)) { console.warn("⚠️ âncora não encontrada:", oldS.slice(0, 45) + "…"); continue; }
    p = p.replace(oldS, newS); n++;
  }
  if (p.length > 8000) throw new Error(`ficou ${p.length} chars (>8000) — trim necessário`);
  if (n === 0) { console.log("Nada a aplicar."); process.exit(0); }

  const { error: ue } = await supabase
    .from("agent_configs").update({ custom_instructions: p }).eq("agent_id", BIANCA_AGENT);
  if (ue) throw new Error("update: " + ue.message);
  console.log(`✅ Bianca ajustada (${before} → ${p.length} chars, ${n} trechos). <8000 ok.`);
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
