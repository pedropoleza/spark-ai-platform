/**
 * Ajusta o prompt da Bianca de "turma em grupo recorrente" (modelo da Marina)
 * pra "conversa 1:1 com a Bianca" (Pedro 2026-06-18: formato da Bianca é 1:1,
 * o da Marina é grupo). Calendário selecionado = "1:1 com Bianca Amorim".
 * Troca linguagem de turma/grupo por 1:1 + ajusta urgência honesta pro modelo
 * de agenda 1:1 (escassez real de horário, não "turma recorrente").
 * Idempotente. NÃO mexe na Marina (grupo segue correto).
 *   npx tsx -r tsconfig-paths/register scripts/patch-bianca-1on1.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const BIANCA_AGENT = "17860a86-ace9-4299-9328-2452151348a0";

const REPLACEMENTS: [string, string][] = [
  [
    "Reunião de FECHAMENTO, com a Bianca, pequeno grupo, dias recorrentes (turmas distintas, horário de NY) — cada pessoa participa de UMA turma.",
    "É uma conversa 1:1 com a Bianca (apresentação personalizada da carreira), marcada na agenda dela. Você resolve: convida → oferece horário REAL da agenda (nunca invente horário) → coleta contato → confirma. NÃO fale em turma/grupo — é só você e a Bianca.",
  ],
  [
    '("a apresentação é literalmente sobre romper esse teto que você acabou de me falar. Topa que eu te coloco na próxima turma?")',
    '("essa conversa com a Bianca é literalmente sobre romper esse teto que você acabou de me falar, personalizada pro teu momento. Topa que eu marco um horário seu com ela?")',
  ],
  [
    'Sem turma/horário confirmado, NÃO afirme reserva: "te aviso o horário da próxima turma e o link vem junto da confirmação".',
    'Sem horário confirmado, NÃO afirme reserva: "te passo os horários que a Bianca tem e o link vem junto da confirmação".',
  ],
  [
    'Só pra quem passou o gate de work permit. Forma segura = compromisso de PRESENÇA ("te coloco na lista de [dia]"). PROIBIDO "última turma do mês", "fecha pra sempre hoje", "te garanto a vaga" — a turma é recorrente. Escassez só com cap REAL confirmado no contexto.',
    'Só pra quem passou o gate de work permit. Forma segura = reserva real do horário ("te reservo esse horário com a Bianca"). A agenda 1:1 dela é limitada, então PODE usar urgência VERDADEIRA de disponibilidade ("essa semana ela tem poucos horários") SÓ se for real no contexto. PROIBIDO inventar escassez ("última chance", "fecha pra sempre hoje", "só esse horário no mês") se não for verdade.',
  ],
  [
    'me chama assim que teu permit sair que eu te encaixo numa turma',
    'me chama assim que teu permit sair que eu marco tua conversa com a Bianca',
  ],
  [
    "só registro + porta aberta + a próxima turma, com carinho",
    "só registro + porta aberta + a próxima janela da agenda dela, com carinho",
  ],
];

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
  let n = 0;
  for (const [oldS, newS] of REPLACEMENTS) {
    if (p.includes(newS)) { console.log("• já aplicado:", newS.slice(0, 40) + "…"); continue; }
    if (!p.includes(oldS)) { console.warn("⚠️ âncora não encontrada:", oldS.slice(0, 50) + "…"); continue; }
    p = p.replace(oldS, newS);
    n++;
  }

  const turmasLeft = (p.match(/turma/gi) || []).length;
  if (p.length > 8000) throw new Error(`ficou ${p.length} chars (>8000)`);
  if (n === 0) { console.log("Nada a aplicar."); process.exit(0); }

  const { error: ue } = await supabase
    .from("agent_configs")
    .update({ custom_instructions: p })
    .eq("agent_id", BIANCA_AGENT);
  if (ue) throw new Error("update: " + ue.message);
  console.log(`✅ Bianca → 1:1 (${before} → ${p.length} chars, ${n} trechos trocados). Ocorrências de "turma" restantes: ${turmasLeft}.`);
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
