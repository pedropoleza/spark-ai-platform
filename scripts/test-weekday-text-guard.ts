/**
 * Golden test do weekday-text-guard (review de uso 2026-08-25).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-weekday-text-guard.ts
 *
 * Os casos "PROD" são as 7 combinações dia+data que o bot escreveu ERRADO na
 * frota entre 13 e 25/08/2026, copiadas verbatim do dump de conversas. Se algum
 * deles voltar a passar sem correção, a guarda regrediu.
 */
import { fixWeekdayDatePairs } from "@/lib/account-assistant/weekday-text-guard";

const TZ = "America/New_York";

interface Caso {
  nome: string;
  texto: string;
  now: string;
  esperaTexto: string;
  esperaCorrecoes: number;
  /** true = o dia escrito batia com o calendário do ano anterior (assinatura H68). */
  esperaAnoAnterior?: boolean;
}

const casos: Caso[] = [
  // ══════════════ ERROS REAIS DE PROD (13→25/08/2026) ══════════════
  {
    nome: "PROD Ana Paula 20/08 — '24/09 é uma quarta' (é QUINTA)",
    texto: "Olhando o calendário, 24/09 é uma quarta. A quinta mais próxima seria 25/09.",
    now: "2026-08-20T05:42:00Z",
    esperaTexto:
      "Olhando o calendário, 24/09 é uma quinta-feira. A quinta mais próxima seria 25/09.",
    esperaCorrecoes: 1,
    esperaAnoAnterior: true,
  },
  {
    nome: "PROD Ana Paula 20/08 — 'Dia 24/09 cai num *domingo*' (artigo troca de gênero)",
    texto: "⚠️ Dia 24/09 cai num *domingo* - confirma que é isso mesmo?",
    now: "2026-08-20T05:41:00Z",
    esperaTexto: "⚠️ Dia 24/09 cai numa *quinta-feira* - confirma que é isso mesmo?",
    esperaCorrecoes: 1,
  },
  {
    nome: "PROD Ana Gusmão 17/08 — 'domingo, 14/09/2026' (é SEGUNDA, bate com 2025)",
    texto: "Dia 14 de setembro seria *domingo, 14/09/2026* - normalmente não é dia de reunião.",
    now: "2026-08-17T21:49:00Z",
    esperaTexto:
      "Dia 14 de setembro seria *segunda-feira, 14/09/2026* - normalmente não é dia de reunião.",
    esperaCorrecoes: 1,
    esperaAnoAnterior: true,
  },
  {
    nome: "PROD Ana Gusmão 17/08 — 'segunda-feira, 15/09' (é TERÇA)",
    texto: "Reagendar com *Claudia Miranda Bispo* para segunda-feira, 15/09/2026 às 7:00 PM (EDT).",
    now: "2026-08-17T21:51:00Z",
    esperaTexto:
      "Reagendar com *Claudia Miranda Bispo* para terça-feira, 15/09/2026 às 7:00 PM (EDT).",
    esperaCorrecoes: 1,
    esperaAnoAnterior: true,
  },
  {
    nome: "PROD Ana Gusmão 17/08 — 'sábado, 13/09' (é DOMINGO)",
    texto: "você quis dizer *segunda-feira, 15/09* ou *sábado, 13/09*?",
    now: "2026-08-17T21:49:00Z",
    esperaTexto: "você quis dizer *terça-feira, 15/09* ou *domingo, 13/09*?",
    esperaCorrecoes: 2,
  },
  {
    nome: "PROD Matheus 15/08 — 'sábado 15/10' (é QUINTA)",
    texto: "Agendar essa mensagem pro *Jeanderson C.* daqui 2 meses, *sábado 15/10 às 9:26 AM (EDT)*",
    now: "2026-08-15T13:26:00Z",
    esperaTexto:
      "Agendar essa mensagem pro *Jeanderson C.* daqui 2 meses, *quinta-feira 15/10 às 9:26 AM (EDT)*",
    esperaCorrecoes: 1,
  },
  {
    nome: "PROD Matheus 21/08 — 'sexta, 21/09' (é SEGUNDA)",
    texto: "Confirma o agendamento pra Lilian em sexta, 21/09 às 2:00 PM?",
    now: "2026-08-21T20:06:00Z",
    esperaTexto: "Confirma o agendamento pra Lilian em segunda-feira, 21/09 às 2:00 PM?",
    esperaCorrecoes: 1,
  },
  {
    nome: "PROD Gustavo 24/08 — 'sexta 22/08' no passado (é SÁBADO, bate com 2025)",
    texto: "Não conseguiu ir ao evento de sexta 22/08.",
    now: "2026-08-24T15:46:00Z",
    esperaTexto: "Não conseguiu ir ao evento de sábado 22/08.",
    esperaCorrecoes: 1,
    esperaAnoAnterior: true,
  },

  // ══════════════ NÃO PODE MEXER (pares CERTOS) ══════════════
  {
    nome: "OK: 'sexta-feira, 28/08' está certo",
    texto: "Marcado! ✅ *Alisson Ferreira Torres* - sexta-feira, 28/08 às 7:00 PM (EDT)",
    now: "2026-08-25T22:54:00Z",
    esperaTexto: "Marcado! ✅ *Alisson Ferreira Torres* - sexta-feira, 28/08 às 7:00 PM (EDT)",
    esperaCorrecoes: 0,
  },
  {
    nome: "OK: 'quarta-feira 26/08' está certo",
    texto: "Marcar com *Kit Fit Meals*, quarta-feira 26/08 às 4:00 PM (EDT), no *Policy Review*.",
    now: "2026-08-25T17:28:00Z",
    esperaTexto: "Marcar com *Kit Fit Meals*, quarta-feira 26/08 às 4:00 PM (EDT), no *Policy Review*.",
    esperaCorrecoes: 0,
  },
  {
    nome: "OK: forma curta certa (tabela do calendar-grounding)",
    texto: "Semana que vem: seg 31/08 · ter 01/09 · qua 02/09",
    now: "2026-08-25T12:00:00Z",
    esperaTexto: "Semana que vem: seg 31/08 · ter 01/09 · qua 02/09",
    esperaCorrecoes: 0,
  },

  // ══════════════ BORDAS ══════════════
  {
    nome: "borda: forma CURTA errada vira curta ('qui 24/09' → 'qui' já certo? não: 'seg 24/09')",
    texto: "Semana: seg 24/09 no calendário",
    now: "2026-09-01T12:00:00Z",
    esperaTexto: "Semana: qui 24/09 no calendário",
    esperaCorrecoes: 1,
  },
  {
    nome: "borda: caixa alta preservada",
    texto: "SEGUNDA-FEIRA, 24/09 confirmada",
    now: "2026-09-01T12:00:00Z",
    esperaTexto: "QUINTA-FEIRA, 24/09 confirmada",
    esperaCorrecoes: 1,
  },
  {
    nome: "borda: capitalizada preservada",
    texto: "Domingo, 24/09 às 10h",
    now: "2026-09-01T12:00:00Z",
    esperaTexto: "Quinta-feira, 24/09 às 10h",
    esperaCorrecoes: 1,
  },
  {
    nome: "borda: ano explícito de 2 dígitos (21/08/27 é sábado)",
    texto: "Nova avaliação anual: sexta-feira, 17/08/27",
    now: "2026-08-17T12:00:00Z",
    esperaTexto: "Nova avaliação anual: terça-feira, 17/08/27",
    esperaCorrecoes: 1,
  },
  {
    nome: "borda: ano explícito FUTURO não é reinterpretado (17/08/2027 = terça)",
    texto: "Task pra 17/08/2027 — nova avaliação. terça-feira, 17/08/2027",
    now: "2026-08-17T12:00:00Z",
    esperaTexto: "Task pra 17/08/2027 — nova avaliação. terça-feira, 17/08/2027",
    esperaCorrecoes: 0,
  },
  {
    nome: "borda: data inválida (31/02) não é tocada",
    texto: "segunda-feira, 31/02 não existe",
    now: "2026-08-25T12:00:00Z",
    esperaTexto: "segunda-feira, 31/02 não existe",
    esperaCorrecoes: 0,
  },
  {
    nome: "borda: mês inválido (10/15) não é tocado",
    texto: "quinta 10/15 do total",
    now: "2026-08-25T12:00:00Z",
    esperaTexto: "quinta 10/15 do total",
    esperaCorrecoes: 0,
  },
  {
    nome: "borda: virada de ano — '05/01' escrito em 28/12 resolve pra 2027",
    texto: "quarta-feira, 05/01 tem reunião",
    now: "2026-12-28T12:00:00Z",
    esperaTexto: "terça-feira, 05/01 tem reunião",
    esperaCorrecoes: 1,
  },
  {
    nome: "borda: sem verbo, ordem B NÃO dispara (não reescreve texto solto)",
    texto: "reunião 24/09 quarta às 7",
    now: "2026-09-01T12:00:00Z",
    esperaTexto: "reunião 24/09 quarta às 7",
    esperaCorrecoes: 0,
  },
  {
    nome: "borda: 'dia' entre o weekday e a data",
    texto: "sexta-feira, dia 24/09 às 11h",
    now: "2026-09-01T12:00:00Z",
    esperaTexto: "quinta-feira, dia 24/09 às 11h",
    esperaCorrecoes: 1,
  },
  {
    nome: "borda: DST — 08/11/2026 (fim do horário de verão nos EUA) é domingo",
    texto: "segunda-feira, 08/11 tem reunião",
    now: "2026-11-01T12:00:00Z",
    esperaTexto: "domingo, 08/11 tem reunião",
    esperaCorrecoes: 1,
  },
  {
    nome: "borda: múltiplos pares errados no mesmo texto",
    texto: "Datas: quarta 24/09, sexta 21/09 e sábado 15/10.",
    now: "2026-09-01T12:00:00Z",
    esperaTexto: "Datas: quinta-feira 24/09, segunda-feira 21/09 e quinta-feira 15/10.",
    esperaCorrecoes: 3,
  },
  {
    nome: "borda: texto sem nenhuma data passa intacto",
    texto: "Nota salva na *Cassia Mendes* com o resumo completo da reunião. ✅",
    now: "2026-08-25T12:00:00Z",
    esperaTexto: "Nota salva na *Cassia Mendes* com o resumo completo da reunião. ✅",
    esperaCorrecoes: 0,
  },
  {
    nome: "borda: fuso do rep decide o 'hoje' que resolve o ano (Chicago)",
    texto: "sexta, 21/09 às 8 AM",
    now: "2026-08-21T20:06:00Z",
    esperaTexto: "segunda-feira, 21/09 às 8 AM",
    esperaCorrecoes: 1,
  },
];

let pass = 0;
let fail = 0;
console.log("=== Golden test: weekday-text-guard ===\n");

for (const c of casos) {
  const tz = c.nome.includes("Chicago") ? "America/Chicago" : TZ;
  const r = fixWeekdayDatePairs(c.texto, tz, new Date(c.now));
  const okTexto = r.text === c.esperaTexto;
  const okQtd = r.corrections.length === c.esperaCorrecoes;
  const okAno =
    c.esperaAnoAnterior === undefined ||
    r.corrections.some((x) => x.batendoAnoAnterior) === c.esperaAnoAnterior;
  const ok = okTexto && okQtd && okAno;
  console.log(`${ok ? "✅" : "❌"} ${c.nome}`);
  if (!ok) {
    console.log(`   esperado: ${JSON.stringify(c.esperaTexto)}`);
    console.log(`   obtido:   ${JSON.stringify(r.text)}`);
    console.log(`   correções: ${r.corrections.length} (esperado ${c.esperaCorrecoes})`);
    if (!okAno) console.log(`   flag ano-anterior divergiu (esperado ${c.esperaAnoAnterior})`);
    if (r.corrections.length) console.log(`   detalhe: ${JSON.stringify(r.corrections)}`);
  }
  ok ? pass++ : fail++;
}

// ── Prova adicional: idempotência (rodar 2× não muda nada) ──
console.log("\n--- idempotência ---");
for (const c of casos.filter((x) => x.esperaCorrecoes > 0).slice(0, 6)) {
  const um = fixWeekdayDatePairs(c.texto, TZ, new Date(c.now));
  const dois = fixWeekdayDatePairs(um.text, TZ, new Date(c.now));
  const ok = dois.text === um.text && dois.corrections.length === 0;
  console.log(`${ok ? "✅" : "❌"} ${c.nome.slice(0, 60)}`);
  if (!ok) console.log(`   2ª passada mexeu: ${JSON.stringify(dois.text)}`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
