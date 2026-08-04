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
  inferExpectedWeekday,
  checkDayOfMonthMatches,
  stripOptionEcho,
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


// ── H67 (2026-08-04, caso Sidney): inferir o dia-da-semana da fala do rep ─────
// A trava do H50 só valia se o LLM lembrasse de passar expected_weekday. Ele
// esquece — e foi assim que a reunião do Sidney nasceu na sexta quando ele
// pediu quinta. Agora o servidor tira da fala do rep.
console.log("\n9. inferExpectedWeekday — servidor não depende do LLM lembrar");
ok(
  "fala do Sidney (verbatim): pega 'quinta'",
  inferExpectedWeekday(
    "Spark, cria uma agenda para mim, com a Eva Aracy, para quinta-feira, às 10 horas da manhã. Reunião inicial, trava a minha agenda nesse horário.",
  ) === "quinta",
);
ok(
  "fala do Milton (verbatim): 'quinta-feira, dia 6' tem data explícita → NÃO infere",
  inferExpectedWeekday(
    "Fazer agendamento de apresentação de produto para quinta-feira, dia 6 de agosto, às 5 PM, com Anderson Nunes.",
  ) === null,
);
ok("sem dia nomeado → null", inferExpectedWeekday("marca pra amanhã às 10") === null);
ok("dois dias citados → null (ambíguo)", inferExpectedWeekday("remarca de segunda pra quarta") === null);
ok("data dd/mm na fala → null (o rep já deu a data)", inferExpectedWeekday("marca quinta 06/08 às 5pm") === null);
ok("acento e maiúscula não atrapalham", inferExpectedWeekday("Marca na TERÇA-FEIRA às 9") === "terca");
ok("sábado sem acento", inferExpectedWeekday("pode ser sabado de manha") === "sabado");
ok("vazio/nulo → null", inferExpectedWeekday("") === null && inferExpectedWeekday(null) === null);
ok(
  "o inferido alimenta a trava: 'quinta' + 17/07 (que é sexta) REJEITA",
  checkWeekdayMatchesDate(
    "2026-07-17T10:00:00-04:00",
    inferExpectedWeekday("cria uma agenda para quinta-feira às 10 da manhã")!,
    TZ,
    NOW,
  ).ok === false,
);
ok(
  "e a data certa passa: 'quinta' + 16/07",
  checkWeekdayMatchesDate(
    "2026-07-16T10:00:00-04:00",
    inferExpectedWeekday("cria uma agenda para quinta-feira às 10 da manhã")!,
    TZ,
    NOW,
  ).ok === true,
);


// ── H67 (caso Milton): o "dia N" que o rep falou tem que ser o dia gravado ────
console.log("\n10. checkDayOfMonthMatches — a data que o REP falou manda");
const FALA_MILTON =
  "Fazer agendamento de apresentação de produto para quinta-feira, dia 6 de agosto, às 5 PM, com Anderson Nunes.";
ok(
  "rep disse 'dia 6' e o bot tentou 07/08 → REJEITA (o erro real)",
  checkDayOfMonthMatches("2026-08-07T17:00:00-04:00", FALA_MILTON, TZ).ok === false,
);
ok(
  "mesma fala, data certa 06/08 → passa",
  checkDayOfMonthMatches("2026-08-06T17:00:00-04:00", FALA_MILTON, TZ).ok === true,
);
ok(
  "a correção cita o dia que o rep falou",
  (checkDayOfMonthMatches("2026-08-07T17:00:00-04:00", FALA_MILTON, TZ).message || "").includes("dia 6"),
);
ok("sem 'dia N' na fala → não opina", checkDayOfMonthMatches("2026-08-07T17:00:00-04:00", "marca quinta às 5", TZ).ok === true);
ok(
  "dois 'dia N' diferentes → não opina (ambíguo)",
  checkDayOfMonthMatches("2026-08-07T17:00:00-04:00", "falei dia 3 e agora quero dia 6", TZ).ok === true,
);
ok(
  "dd/mm completo na fala → não opina (o LLM só copia)",
  checkDayOfMonthMatches("2026-08-07T17:00:00-04:00", "marca 06/08 às 5pm", TZ).ok === true,
);
ok(
  "usa o fuso do rep: 23:30 EDT do dia 6 não vira dia 7",
  checkDayOfMonthMatches("2026-08-07T03:30:00Z", "marca dia 6 às 23:30", TZ).ok === true,
);
ok("fala vazia → não opina", checkDayOfMonthMatches("2026-08-07T17:00:00-04:00", "", TZ).ok === true);


// ── H68: o eco do menu não pode virar "fala do rep" ──────────────────────────
// No fluxo de confirmação, o turno que chama create_appointment é o CLIQUE do
// botão — e a mensagem persistida embute a pergunta INTEIRA do bot. Sem
// limpar, a trava conferia o bot contra ele mesmo. (Medido: das 167 criações
// de reunião em 30 dias, ZERO tinham o pedido original na fala do turno.)
console.log("\n11. stripOptionEcho + janela de falas (caso Sidney completo)");
const ECO =
  'Forçar mesmo assim ✅ — (resposta à pergunta: "O slot das 10:00 AM de quinta 17/07 não tá disponível no calendário Consulta Inicial. O que prefere fazer?")\n[opção escolhida na lista: "Forçar mesmo assim ✅"]';
ok("tira a pergunta do bot do eco", stripOptionEcho(ECO) === "Forçar mesmo assim ✅");
ok(
  "sem limpar, o eco traria a data do PRÓPRIO bot (17/07) como se fosse do rep",
  /17\/07/.test(ECO) && !/17\/07/.test(stripOptionEcho(ECO)),
);
ok(
  "tira também o bloco de PISTA do contato",
  stripOptionEcho(
    'Hugo Idelli Casarotto — (resposta à pergunta: "Qual Hugo?")\n[opção escolhida na lista: "Hugo" — contact_id JED1od7DVcL6TVgxavcm como PISTA: valide com get_contact]',
  ) === "Hugo Idelli Casarotto",
);
ok("texto normal passa intocado", stripOptionEcho("marca quinta às 10") === "marca quinta às 10");

// A janela real do caso Sidney: o pedido com "quinta-feira" está 4 mensagens
// atrás do turno que criou a reunião.
const JANELA_SIDNEY = [
  "Spark, cria uma agenda para mim, com a Eva Aracy, para quinta-feira, às 10 horas da manhã. Reunião inicial, trava a minha agenda nesse horário.",
  'Criar contato + reunião — (resposta à pergunta: "Não encontrei a Eva Aracy no sistema. Como quer prosseguir?")',
  "Eva Aracy Brito school Josie \nTel: 857 351 7588 \nE-mail: evareis2004@gmail.com",
  ECO,
].map(stripOptionEcho).join("\n");
ok("na janela limpa sobra UM dia-da-semana: quinta", inferExpectedWeekday(JANELA_SIDNEY) === "quinta");
ok(
  "e a trava rejeita o 17/07 que o bot tentou (é sexta)",
  checkWeekdayMatchesDate("2026-07-17T10:00:00-04:00", inferExpectedWeekday(JANELA_SIDNEY)!, TZ, NOW).ok === false,
);
ok(
  "com a data certa (16/07) passa",
  checkWeekdayMatchesDate("2026-07-16T10:00:00-04:00", inferExpectedWeekday(JANELA_SIDNEY)!, TZ, NOW).ok === true,
);
ok(
  "janela com DOIS dias-da-semana diferentes → não infere (evita falso-positivo)",
  inferExpectedWeekday("marca na segunda\nagora quero mudar pra quarta") === null,
);


// ── H68: quando o dia-da-semana foi INFERIDO, a correção não pode ditar data ──
// Backtest de 30 dias: a inferência barraria 7 agendamentos e, revisando um a
// um, só ~3 eram erro real — nos outros a janela pegou um dia-da-semana de
// outro assunto. Mandar "re-chame nessa data" nesses casos empurraria pro dia
// errado. Então a mensagem do modo inferido oferece a saída explícita.
console.log("\n12. correção do modo inferido é mais humilde que a do modo explícito");
{
  const explicito = checkWeekdayMatchesDate("2026-07-17T10:00:00-04:00", "quinta", TZ, NOW, false);
  const inferido = checkWeekdayMatchesDate("2026-07-17T10:00:00-04:00", "quinta", TZ, NOW, true);
  ok("os dois rejeitam", explicito.ok === false && inferido.ok === false);
  ok(
    "explícito manda re-chamar na data do dia pedido",
    (explicito.message || "").includes("re-chame com start_time NESSA data"),
  );
  ok(
    "inferido NÃO manda re-chamar nessa data",
    !(inferido.message || "").includes("re-chame com start_time NESSA data"),
  );
  ok(
    "inferido oferece a saída: passar expected_weekday explícito",
    (inferido.message || "").includes("expected_weekday"),
  );
  ok("inferido manda olhar a tabela", (inferido.message || "").includes("CALENDÁRIO REAL"));
  ok(
    "e a saída funciona de fato: expected_weekday = sexta na data de sexta passa",
    checkWeekdayMatchesDate("2026-07-17T10:00:00-04:00", "sexta", TZ, NOW, false).ok === true,
  );
}

console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : " ✅"}`);
process.exit(fail ? 1 : 0);
