/**
 * Testes da tabela de calendário do runtime context (H67, caso Milton 2026-08-04).
 *
 * O que se protege aqui: as datas do bloco têm que sair CERTAS do calendário de
 * 2026 (o modelo errava usando o de 2025), no fuso do rep, com virada de mês, de
 * ano e de DST corretas.
 *
 * Rodar: npx tsx scripts/test-calendar-grounding.ts
 */
import { buildCalendarGrounding } from "../src/lib/account-assistant/calendar-grounding";

let pass = 0,
  fail = 0;
function check(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

const NY = "America/New_York";

// ── 1. O caso Milton, verbatim ───────────────────────────────────────────────
// 2026-08-04 16:14 EDT (20:14 UTC) — o instante em que o bot disse "quinta 07/08".
console.log("\n1. Caso Milton (04/08/2026 16:14 EDT) — quinta É 06/08, não 07/08");
const milton = buildCalendarGrounding(new Date("2026-08-04T20:14:00Z"), NY);
check("hoje = terça-feira, 04/08/2026", milton.hojeLabel === "terça-feira, 04/08/2026", milton.hojeLabel);
check("a tabela traz 'qui 06/08'", milton.block.includes("qui 06/08"));
check(
  "a tabela NÃO traz 'qui 07/08' (o erro do bot)",
  !milton.block.includes("qui 07/08"),
);
check("07/08 aparece como SEXTA", milton.block.includes("sex 07/08"));
check("06/08 não aparece como quarta (o outro item do menu errado)", !milton.block.includes("qua 06/08"));
check("marca o HOJE", milton.block.includes("ter 04/08 (HOJE)"));
check("marca o amanhã", milton.block.includes("qua 05/08 (amanhã)"));
check(
  "cobre 'sexta da próxima semana' = 14/08 (pedido real do Milton no mesmo dia)",
  milton.block.includes("sex 14/08"),
);
check(
  "cobre 'quarta que vem dia 12' = 12/08 (outro pedido real do mesmo dia)",
  milton.block.includes("qua 12/08"),
);
check("tem a regra de copiar, não calcular", milton.block.includes("NUNCA calcule"));

// ── 2. Toda a frota: nenhuma data do bloco pode bater com o calendário de 2025 ─
console.log("\n2. Anti-2025: todo par dia/data do bloco confere com 2026");
{
  const bloco = buildCalendarGrounding(new Date("2026-08-04T20:14:00Z"), NY).block;
  const curto = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const pares = [...bloco.matchAll(/(dom|seg|ter|qua|qui|sex|sáb) (\d{2})\/(\d{2})/g)];
  check("achou os 21 dias", pares.length === 21, `achou ${pares.length}`);
  let okAll = true;
  for (const [, wd, dd, mm] of pares) {
    const real = new Date(Date.UTC(2026, Number(mm) - 1, Number(dd))).getUTCDay();
    if (curto[real] !== wd) {
      okAll = false;
      console.error(`     ${wd} ${dd}/${mm} → real 2026 é ${curto[real]}`);
    }
  }
  check("todos os 21 pares batem com 2026", okAll);
}

// ── 3. Fuso: o "hoje" é o do rep, não o do servidor ──────────────────────────
console.log("\n3. Fuso do rep manda no 'hoje'");
{
  // 03:30 UTC = 23:30 de terça em Nova York (-4) e 00:30 de quarta em São Paulo
  // (-3, sem horário de verão desde 2019). Mesmo instante, dias diferentes.
  const ny = buildCalendarGrounding(new Date("2026-08-05T03:30:00Z"), NY);
  check("NY: ainda é terça 04/08", ny.hojeLabel === "terça-feira, 04/08/2026", ny.hojeLabel);
  const sp = buildCalendarGrounding(new Date("2026-08-05T03:30:00Z"), "America/Sao_Paulo");
  check("São Paulo: já é quarta 05/08", sp.hojeLabel === "quarta-feira, 05/08/2026", sp.hojeLabel);
  check(
    "e a tabela vira junto (o HOJE muda de dia)",
    ny.block.includes("ter 04/08 (HOJE)") && sp.block.includes("qua 05/08 (HOJE)"),
  );
}

// ── 4. Semana começa na segunda (convenção BR) ───────────────────────────────
console.log("\n4. Semana começa na segunda");
{
  // Domingo 09/08/2026: pertence à semana que COMEÇOU em 03/08.
  const dom = buildCalendarGrounding(new Date("2026-08-09T16:00:00Z"), NY);
  check("domingo 09/08 fecha a semana do dia 03", dom.block.includes("Essa semana: seg 03/08"));
  check("domingo é o último da linha, marcado como HOJE", dom.block.includes("dom 09/08 (HOJE)"));
  check("segunda 10/08 já é 'semana que vem'", dom.block.includes("Semana que vem: seg 10/08"));
}

// ── 5. Bordas: virada de mês, virada de ano, ano bissexto e DST ──────────────
console.log("\n5. Bordas de calendário");
{
  const fimMes = buildCalendarGrounding(new Date("2026-08-30T16:00:00Z"), NY);
  check("vira o mês sem quebrar (31/08 → 01/09)", fimMes.block.includes("seg 31/08") && fimMes.block.includes("ter 01/09"));

  const fimAno = buildCalendarGrounding(new Date("2026-12-28T16:00:00Z"), NY);
  check("vira o ano (31/12 quinta → 01/01 sexta)", fimAno.block.includes("qui 31/12") && fimAno.block.includes("sex 01/01"));

  const bissexto = buildCalendarGrounding(new Date("2028-02-28T16:00:00Z"), NY);
  check("ano bissexto tem 29/02", bissexto.block.includes("29/02"));

  // DST nos EUA em 2026: relógio volta 1h no domingo 01/11. A tabela é de DIAS,
  // não pode escorregar por causa disso.
  const dst = buildCalendarGrounding(new Date("2026-10-30T16:00:00Z"), NY);
  const curto = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const pares = [...dst.block.matchAll(/(dom|seg|ter|qua|qui|sex|sáb) (\d{2})\/(\d{2})/g)];
  let dstOk = true;
  for (const [, wd, dd, mm] of pares) {
    const ano = Number(mm) === 1 ? 2027 : 2026;
    const real = new Date(Date.UTC(ano, Number(mm) - 1, Number(dd))).getUTCDay();
    if (curto[real] !== wd) dstOk = false;
  }
  check("atravessa a virada de horário de verão sem escorregar", dstOk);
}

// ── 6. Fail-soft: fuso inválido não derruba o turno ──────────────────────────
console.log("\n6. Fail-soft");
{
  const ruim = buildCalendarGrounding(new Date("2026-08-04T20:14:00Z"), "Nao/Existe");
  check("fuso inválido → bloco vazio (não lança)", ruim.block === "" && ruim.hojeLabel === "");
}

// ── 7. Custo: o bloco precisa ser barato (vai em TODO turno) ─────────────────
console.log("\n7. Custo do bloco");
{
  const b = buildCalendarGrounding(new Date("2026-08-04T20:14:00Z"), NY).block;
  check(`bloco < 700 chars (~175 tok) — tem ${b.length}`, b.length < 700);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
