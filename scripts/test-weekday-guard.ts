/**
 * Teste da guarda weekday↔data (H50, caso Caua 2026-07-15).
 * Puro (sem DB/rede). Fuso America/New_York (EDT em julho). Roda:
 *   npx tsx -r tsconfig-paths/register scripts/test-weekday-guard.ts
 *
 * Ground truth julho/2026: 13=Seg 14=Ter 15=Qua(hoje) 16=Qui 20=Seg(próxima).
 */
import {
  parseWeekdayPt,
  weekdayOfIso,
  nextDateForWeekday,
  formatWeekdayDate,
  checkWeekdayMatchesDate,
} from "../src/lib/account-assistant/weekday-guard";

const TZ = "America/New_York";
// "agora" fixo = quarta 15/07/2026 11:00 EDT (o dia do bug do Caua).
const NOW = new Date("2026-07-15T15:00:00Z");

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("parseWeekdayPt:");
ok("segunda → 1", parseWeekdayPt("segunda") === 1);
ok("segunda-feira → 1", parseWeekdayPt("segunda-feira") === 1);
ok("terça (acento) → 2", parseWeekdayPt("terça") === 2);
ok("terca (sem acento) → 2", parseWeekdayPt("terca") === 2);
ok("QUARTA-FEIRA (caps) → 3", parseWeekdayPt("QUARTA-FEIRA") === 3);
ok("sábado → 6", parseWeekdayPt("sábado") === 6);
ok("monday (en) → 1", parseWeekdayPt("monday") === 1);
ok("'quarta que vem' (prefixo) → 3", parseWeekdayPt("quarta que vem") === 3);
ok("'amanhã' → null", parseWeekdayPt("amanhã") === null);
ok("'20/07' → null", parseWeekdayPt("20/07") === null);
ok("'' → null", parseWeekdayPt("") === null);

console.log("\nweekdayOfIso (America/New_York):");
ok("15/07 20h EDT → quarta(3)", weekdayOfIso("2026-07-15T20:00:00-04:00", TZ) === 3);
ok("14/07 17:30 EDT → terça(2)", weekdayOfIso("2026-07-14T17:30:00-04:00", TZ) === 2);
ok("13/07 → segunda(1)", weekdayOfIso("2026-07-13T09:00:00-04:00", TZ) === 1);
// Fuso: 15/07 00:30 UTC = 14/07 20:30 EDT → terça, não quarta.
ok("borda de fuso (00:30Z rola pro dia anterior no EDT)", weekdayOfIso("2026-07-15T00:30:00Z", TZ) === 2, `deu ${weekdayOfIso("2026-07-15T00:30:00Z", TZ)}`);
// DST: janeiro (EST). 05/01/2026 = segunda.
ok("DST-safe: 05/01/2026 → segunda(1)", weekdayOfIso("2026-01-05T10:00:00-05:00", TZ) === 1);

console.log("\nnextDateForWeekday (a partir de qua 15/07):");
ok("próxima segunda → 20/07/2026", nextDateForWeekday(1, TZ, NOW) === "20/07/2026", `deu ${nextDateForWeekday(1, TZ, NOW)}`);
ok("próxima quarta (hoje) → 15/07/2026", nextDateForWeekday(3, TZ, NOW) === "15/07/2026", `deu ${nextDateForWeekday(3, TZ, NOW)}`);
ok("próxima quinta → 16/07/2026", nextDateForWeekday(4, TZ, NOW) === "16/07/2026", `deu ${nextDateForWeekday(4, TZ, NOW)}`);
ok("próximo domingo → 19/07/2026", nextDateForWeekday(0, TZ, NOW) === "19/07/2026", `deu ${nextDateForWeekday(0, TZ, NOW)}`);

console.log("\nformatWeekdayDate:");
ok(
  "16/07 20h → 'quinta-feira, 16/07/2026 às 20:00'",
  formatWeekdayDate("2026-07-16T20:00:00-04:00", TZ) === "quinta-feira, 16/07/2026 às 20:00",
  `deu ${formatWeekdayDate("2026-07-16T20:00:00-04:00", TZ)}`,
);

console.log("\ncheckWeekdayMatchesDate (o coração do fix):");
// BUG DO CAUA: pediu 'segunda' mas o LLM mandou 14/07 (terça) → REJEITA.
const cauaSeg = checkWeekdayMatchesDate("2026-07-14T17:30:00-04:00", "segunda-feira", TZ, NOW);
ok("REJEITA 'segunda' em 14/07 (é terça)", cauaSeg.ok === false);
ok("  msg cita a próxima segunda 20/07", !!cauaSeg.message?.includes("20/07/2026"), cauaSeg.message);
// BUG DO CAUA #2: 'quarta' mas mandou 16/07 (quinta) → REJEITA.
ok("REJEITA 'quarta' em 16/07 (é quinta)", checkWeekdayMatchesDate("2026-07-16T20:00:00-04:00", "quarta", TZ, NOW).ok === false);
// CORRETO: 'quarta' em 15/07 (é quarta) → PASSA.
ok("ACEITA 'quarta' em 15/07 (bate)", checkWeekdayMatchesDate("2026-07-15T20:00:00-04:00", "quarta-feira", TZ, NOW).ok === true);
// CORRETO: 'segunda' em 20/07 (próxima segunda) → PASSA.
ok("ACEITA 'segunda' em 20/07 (bate)", checkWeekdayMatchesDate("2026-07-20T17:30:00-04:00", "segunda", TZ, NOW).ok === true);
// SEM dia nomeado → não valida (não bloqueia data explícita/amanhã).
ok("SKIP quando expected='amanhã' (não é dia)", checkWeekdayMatchesDate("2026-07-16T20:00:00-04:00", "amanhã", TZ, NOW).ok === true);
ok("SKIP quando expected='' ", checkWeekdayMatchesDate("2026-07-16T20:00:00-04:00", "", TZ, NOW).ok === true);

console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : " ✅"}`);
process.exit(fail ? 1 : 0);
