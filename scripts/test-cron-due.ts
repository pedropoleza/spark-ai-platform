/**
 * Testes da janela de tolerância do cron proativo (fix 2026-08-05, caso Natalia).
 *
 * O que se protege aqui: o "Resumo matinal" não pode voltar a ser uma corrida de
 * 60 segundos onde só os primeiros reps da fila recebem. Cada caso abaixo com
 * "(era o bug)" retornava FALSE antes do fix — e o rep perdia o dia inteiro.
 *
 * Rodar: npx tsx -r tsconfig-paths/register scripts/test-cron-due.ts
 */
import {
  isCronDue,
  shouldFireCron,
  computeNextRunAt,
} from "../src/lib/account-assistant/proactive/cron-evaluator";

let pass = 0,
  fail = 0;
function ok(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

const BRIEFING = "0 8 * * 1-5"; // a regra real do "Resumo matinal" em prod
const NY = "America/New_York";
const CHI = "America/Chicago";
const SP = "America/Sao_Paulo";
const GRACE = 180;

// 2026-08-05 é uma QUARTA. NY está em EDT (UTC-4), então 8:00 local = 12:00Z.
const em = (iso: string) => new Date(iso);

// ── 1. A janela: o que o fix passou a alcançar ──────────────────────────────
console.log("\n1. janela de tolerância (o rep que não cabia no minuto)");
ok("no minuto exato do cron", isCronDue(BRIEFING, NY, GRACE, em("2026-08-05T12:00:30Z")));
ok(
  "5 min depois — tick seguinte pega o rep (era o bug)",
  isCronDue(BRIEFING, NY, GRACE, em("2026-08-05T12:05:00Z")),
);
ok(
  "1min31s depois — o teto real observado em prod era :01:01 (era o bug)",
  isCronDue(BRIEFING, NY, GRACE, em("2026-08-05T12:01:31Z")),
);
ok(
  "179 min depois ainda vale",
  isCronDue(BRIEFING, NY, GRACE, em("2026-08-05T14:59:00Z")),
);
ok(
  "181 min depois já expirou",
  !isCronDue(BRIEFING, NY, GRACE, em("2026-08-05T15:01:00Z")),
);
ok(
  "antes da hora não antecipa",
  !isCronDue(BRIEFING, NY, GRACE, em("2026-08-05T11:30:00Z")),
);

// ── 2. O que a janela NÃO pode fazer ────────────────────────────────────────
console.log("\n2. limites — a tolerância não pode virar envio errado");
ok(
  "sábado não dispara regra 1-5",
  !isCronDue(BRIEFING, NY, GRACE, em("2026-08-08T12:05:00Z")),
);
ok(
  "domingo não dispara regra 1-5",
  !isCronDue(BRIEFING, NY, GRACE, em("2026-08-09T12:05:00Z")),
);
ok(
  "de manhã cedo NÃO ressuscita o briefing de ontem",
  !isCronDue(BRIEFING, NY, GRACE, em("2026-08-06T09:00:00Z")),
);
{
  // Cron de 23h: 23:00 EDT do dia 05 = 03:00Z do dia 06.
  const noturno = "0 23 * * *";
  ok(
    "23:30 local ainda é o mesmo dia → vale",
    isCronDue(noturno, NY, GRACE, em("2026-08-06T03:30:00Z")),
  );
  ok(
    "00:30 local já virou o dia → não entrega de madrugada",
    !isCronDue(noturno, NY, GRACE, em("2026-08-06T04:30:00Z")),
  );
}
ok("fuso inválido falha fechado", !isCronDue(BRIEFING, "Marte/Olympus", GRACE, em("2026-08-05T12:00:30Z")));

// ── 3. Fuso do rep — a frota é multi-fuso ───────────────────────────────────
console.log("\n3. cada rep no seu fuso");
ok(
  "Chicago às 8:00 CDT (13:00Z) vale",
  isCronDue(BRIEFING, CHI, GRACE, em("2026-08-05T13:05:00Z")),
);
ok(
  "Chicago às 12:05Z ainda são 7:05 lá — não vale",
  !isCronDue(BRIEFING, CHI, GRACE, em("2026-08-05T12:05:00Z")),
);
ok(
  "São Paulo (sem horário de verão) às 8:00 = 11:00Z",
  isCronDue(BRIEFING, SP, GRACE, em("2026-08-05T11:05:00Z")),
);

// ── 4. Compatibilidade: grace 0 é o comportamento antigo ────────────────────
console.log("\n4. grace 0 preserva o comportamento antigo");
for (const instante of ["2026-08-05T12:00:30Z", "2026-08-05T12:05:00Z", "2026-08-05T11:30:00Z"]) {
  const antigo = shouldFireCron(BRIEFING, NY, em(instante));
  const novo = isCronDue(BRIEFING, NY, 0, em(instante));
  ok(`grace 0 == shouldFireCron em ${instante.slice(11, 19)}`, antigo === novo);
}

// ── 5. Regressão do resto do módulo (cache de formatter) ────────────────────
console.log("\n5. cache de formatter não quebrou o resto");
{
  const prox = computeNextRunAt(BRIEFING, NY, em("2026-08-05T13:00:00Z"));
  ok("próximo disparo é quinta 08:00 EDT (12:00Z)", prox?.toISOString() === "2026-08-06T12:00:00.000Z",
    String(prox?.toISOString()));
  const proxSexta = computeNextRunAt(BRIEFING, NY, em("2026-08-07T13:00:00Z"));
  ok("na sexta à tarde, o próximo pula o fim de semana (segunda)",
    proxSexta?.toISOString() === "2026-08-10T12:00:00.000Z", String(proxSexta?.toISOString()));
  ok("fuso inválido devolve null", computeNextRunAt(BRIEFING, "Marte/Olympus", em("2026-08-05T13:00:00Z")) === null);
}

// ── 6. O cenário da frota: 43 reps em série dentro do tick ──────────────────
console.log("\n6. cenário real: 43 reps, ~4s cada, ticks de 30s");
{
  const inicio = Date.parse("2026-08-05T12:00:00Z");
  const CUSTO_BRIEFING_MS = 4_000; // calls no Spark Leads + LLM
  const CUSTO_DEDUP_MS = 50; // rep já atendido hoje: só a query de dedup
  // Simula os dois mundos separadamente, porque o custo do tick depende de
  // QUEM já foi atendido — e é justamente isso que muda entre eles.
  const simular = (venceu: (agora: Date) => boolean): Set<number> => {
    const alcancados = new Set<number>();
    for (let tick = 0; tick < 20; tick++) {
      // Ticks de 30s por 10 minutos; cada tick devolve o controle aos 20s.
      const tickTs = inicio + tick * 30_000;
      let gasto = 0;
      for (let rep = 0; rep < 43 && gasto <= 20_000; rep++) {
        const agora = new Date(tickTs + gasto);
        if (alcancados.has(rep)) {
          gasto += CUSTO_DEDUP_MS;
          continue;
        }
        if (venceu(agora)) alcancados.add(rep);
        gasto += CUSTO_BRIEFING_MS;
      }
    }
    return alcancados;
  };
  const alcancadosAntes = simular((agora) => shouldFireCron(BRIEFING, NY, agora));
  const alcancadosDepois = simular((agora) => isCronDue(BRIEFING, NY, GRACE, agora));
  ok(`antes do fix a frota inteira NÃO era coberta (cobriu ${alcancadosAntes.size}/43)`, alcancadosAntes.size < 43);
  ok(`depois do fix cobre os 43 (cobriu ${alcancadosDepois.size}/43)`, alcancadosDepois.size === 43);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
