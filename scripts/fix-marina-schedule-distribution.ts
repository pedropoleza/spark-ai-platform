/**
 * Marina (Isabella) — corrige o viés de SEMPRE oferecer quinta (Pedro 2026-06-22).
 * As turmas são seg/ter/qui 8pm ET; a IA já sabe a data+dia de hoje (o builder
 * injeta "Monday, June 22, 2026, 8:00 PM" no fuso da location). O viés vinha da
 * INSTRUÇÃO vaga ("próxima turma") + exemplos ancorados em "quinta". Fix:
 *  - regra explícita do "dia MAIS PRÓXIMO" (inclui HOJE se ainda não deu 8pm)
 *  - tira "quinta" dos exemplos (URGÊNCIA e CAP) pra não ancorar.
 * Idempotente, mantém <8000.
 *   npx tsx -r tsconfig-paths/register scripts/fix-marina-schedule-distribution.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const MARINA = "3976b4b6-0345-4f25-b964-138bb7960058";

const REPLACEMENTS: [string, string][] = [
  [
    'Ofereça SEMPRE a próxima turma concreta.\n1. CONVIDA pra próxima turma (só quem passou o gate). Diz o dia concreto (próx. segunda/terça/quinta) às 8pm ET e CONVERTE pro fuso do lead ("8pm de NY = 7pm aí no Texas").',
    'Ofereça SEMPRE a turma MAIS PRÓXIMA a partir de HOJE (você sabe a data e o dia da semana de hoje — estão no topo do prompt).\n1. CONVIDA pra próxima turma (só quem passou o gate). REGRA DO DIA (siga à risca): das turmas seg/ter/qui às 8pm ET, ofereça a PRÓXIMA que ainda não passou. Se HOJE for seg/ter/qui e ainda não deu 8pm no horário de NY, ofereça HOJE mesmo. Senão o próximo dia de turma na ordem seg→ter→qui→seg. Pode dar 2 opções (a mais próxima + a seguinte) pra escolher. NUNCA ofereça sempre quinta — distribua entre seg/ter/qui conforme o que está mais perto de hoje. Diz o dia concreto às 8pm ET e CONVERTE pro fuso do lead ("8pm de NY = 7pm aí no Texas").',
  ],
  [
    'Use compromisso de PRESENÇA real ("te coloco na lista de quinta e te mando o link").',
    'Use compromisso de PRESENÇA real ("te coloco na lista de [o dia que vocês combinaram] e te mando o link").',
  ],
  [
    'no MÁX 1 troca de turma ("se quinta não dá, tem segunda")',
    'no MÁX 1 troca de turma ("se [um dia] não der, tem [outro dia de seg/ter/qui]")',
  ],
];

async function main() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_configs").select("custom_instructions").eq("agent_id", MARINA).single();
  if (error || !data) throw new Error("load: " + (error?.message || "sem config"));
  let p: string = data.custom_instructions;
  const before = p.length;
  let n = 0;
  for (const [oldS, newS] of REPLACEMENTS) {
    if (p.includes(newS)) { console.log("• já aplicado"); continue; }
    if (!p.includes(oldS)) { console.warn("⚠️ âncora não encontrada:", oldS.slice(0, 50) + "…"); continue; }
    p = p.replace(oldS, newS); n++;
  }
  if (p.length > 8000) throw new Error(`ficou ${p.length} chars (>8000)`);
  if (/\bMaria\b/.test(p)) throw new Error("apareceu 'Maria' — abortar");
  if (n === 0) { console.log("Nada a aplicar."); process.exit(0); }
  const { error: ue } = await supabase.from("agent_configs").update({ custom_instructions: p }).eq("agent_id", MARINA);
  if (ue) throw new Error("update: " + ue.message);
  console.log(`✅ Marina schedule fix (${before} → ${p.length} chars, ${n} trechos). Viés de quinta removido + regra do dia mais próximo.`);
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
