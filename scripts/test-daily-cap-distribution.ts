/**
 * Guard-rail F60 (Pedro 2026-06-10) — cap diário nos caminhos AUTOMÁTICOS.
 *
 * A UI promete "Aborda até N pessoas/dia" mas o teto só era enforçado no chat
 * do SparkBot. Prospecção (outreach-runner), campanhas /hub (campaign-populator)
 * e recorrentes (recurring-runner) enfileiravam TODOS os contatos sem teto.
 *
 * Estes testes travam a invariante central: com daily_cap=N e >N contatos,
 * NENHUM dia-de-envio (America/New_York) tem mais que N recipients. E que o
 * overflow ROLA pro próximo dia (não trunca), com o dia 0 respeitando o que já
 * estava agendado (seed via usedByEtDay).
 *
 * Pura/determinística: injeta rng e baseStart fixos. Sem DB, sem rede.
 */
import { config } from "dotenv";
config();

import {
  distributeScheduledAtsByDailyCap,
  toEtDayString,
} from "../src/lib/account-assistant/tools/bulk-messages";

let passed = 0,
  failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}
function assert(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || "assertion failed");
}

/** Conta recipients por dia-ET (YYYY-MM-DD em America/New_York). */
function byEtDay(dates: Date[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of dates) m.set(toEtDayString(d), (m.get(toEtDayString(d)) ?? 0) + 1);
  return m;
}
function maxPerDay(dates: Date[]): number {
  return Math.max(0, ...byEtDay(dates).values());
}
/** Hora ET (0-23) de um instante. */
function etHour(d: Date): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
  }).format(d);
  return Number(h) % 24; // "24" (meia-noite em alguns runtimes) → 0
}
function gapsSec(dates: Date[]): number[] {
  const g: number[] = [];
  for (let i = 1; i < dates.length; i++) g.push((dates[i].getTime() - dates[i - 1].getTime()) / 1000);
  return g;
}

// Segunda-feira 09:00 EDT (13:00Z). Dia 0 começa cedo → cabe folgado.
const BASE = new Date("2026-06-15T13:00:00Z");
const ZERO = () => 0; // jitter determinístico = 0

console.log("\n=== F60: distribuição respeitando cap diário (dia-ET) ===\n");

test("INVARIANTE: cap=10, 35 contatos → nenhum dia-ET passa de 10, todos agendados", () => {
  const ats = distributeScheduledAtsByDailyCap({
    count: 35,
    dailyCap: 10,
    intervalSeconds: 180,
    jitterSeconds: 0,
    baseStart: BASE,
    rng: ZERO,
  });
  assert(ats.length === 35, `len=${ats.length} (esperava 35 — espalha, não trunca)`);
  assert(maxPerDay(ats) <= 10, `maxPerDay=${maxPerDay(ats)} (>10 = cap violado)`);
  const counts = [...byEtDay(ats).values()].sort((a, b) => b - a);
  assert(counts.length === 4, `dias=${counts.length} (esperava 4: 10/10/10/5)`);
  assert(JSON.stringify(counts) === JSON.stringify([10, 10, 10, 5]), `dist=${counts.join("/")}`);
});

test("INVARIANTE com jitter real: cap=25, 130 contatos, jitter=30 → nenhum dia passa de 25", () => {
  const ats = distributeScheduledAtsByDailyCap({
    count: 130,
    dailyCap: 25,
    intervalSeconds: 120,
    jitterSeconds: 30,
    baseStart: BASE,
    // rng default (Math.random) — jitter forward até 30s não cruza meia-noite
    // porque os dias rolados começam às 09:00 e 25×120s=50min de preenchimento.
  });
  assert(ats.length === 130, `len=${ats.length}`);
  assert(maxPerDay(ats) <= 25, `maxPerDay=${maxPerDay(ats)} (>25 = cap violado)`);
});

test("overflow ROLA pro próximo dia começando às 09:00 ET", () => {
  const ats = distributeScheduledAtsByDailyCap({
    count: 35,
    dailyCap: 10,
    intervalSeconds: 180,
    jitterSeconds: 0,
    baseStart: BASE,
    rng: ZERO,
  });
  // 1º slot do dia 1 = index 10 (após encher os 10 do dia 0).
  assert(etHour(ats[10]) === 9, `1º slot do dia 1 às ${etHour(ats[10])}h ET (esperava 9h)`);
  assert(toEtDayString(ats[10]) !== toEtDayString(ats[9]), "dia 1 deveria ser dia-ET diferente do dia 0");
});

test("seed de uso de HOJE reduz a capacidade do dia 0", () => {
  const todayEt = toEtDayString(BASE);
  const ats = distributeScheduledAtsByDailyCap({
    count: 10,
    dailyCap: 10,
    intervalSeconds: 180,
    jitterSeconds: 0,
    baseStart: BASE,
    usedByEtDay: new Map([[todayEt, 7]]), // 7 já agendados hoje → sobram 3
    rng: ZERO,
  });
  const today = [...ats].filter((d) => toEtDayString(d) === todayEt).length;
  assert(today === 3, `dia 0 recebeu ${today} (esperava 3 — 10 cap - 7 já usados)`);
  assert(ats.length === 10, `len=${ats.length}`);
  assert(maxPerDay(ats) <= 10, `algum dia passou de 10 (incl. seed): ${maxPerDay(ats)}`);
});

test("cap=null → linear histórico (gap == interval, jitter 0)", () => {
  const ats = distributeScheduledAtsByDailyCap({
    count: 5,
    dailyCap: null,
    intervalSeconds: 90,
    jitterSeconds: 0,
    baseStart: BASE,
    rng: ZERO,
  });
  assert(ats.length === 5, `len=${ats.length}`);
  assert(gapsSec(ats).every((g) => g === 90), `gaps inesperados: ${[...new Set(gapsSec(ats))].join(",")}`);
  assert(ats[0].getTime() === BASE.getTime(), "1º slot deveria ser exatamente o baseStart");
});

test("cap<=0 tratado como sem teto (linear)", () => {
  const ats = distributeScheduledAtsByDailyCap({
    count: 4,
    dailyCap: 0,
    intervalSeconds: 60,
    jitterSeconds: 0,
    baseStart: BASE,
    rng: ZERO,
  });
  assert(gapsSec(ats).every((g) => g === 60), "cap 0 deveria virar linear");
});

test("cap ENORME → cruza meia-noite naturalmente sem nenhum dia exceder capacidade física", () => {
  // 2000 × 90s = 50h → naturalmente atravessa ~3 dias-ET. Cap gigante nunca é o
  // gargalo; o limite vira a capacidade física do dia. Confirma que a detecção
  // de cruzamento natural de meia-noite funciona (não empilha 2000 no dia 0).
  const ats = distributeScheduledAtsByDailyCap({
    count: 2000,
    dailyCap: 1_000_000,
    intervalSeconds: 90,
    jitterSeconds: 0,
    baseStart: BASE,
    rng: ZERO,
  });
  assert(ats.length === 2000, `len=${ats.length}`);
  assert(byEtDay(ats).size >= 2, "deveria cruzar pelo menos 2 dias-ET");
  // 24h/90s = 960 slots/dia no máximo fisicamente possível.
  assert(maxPerDay(ats) <= 961, `maxPerDay=${maxPerDay(ats)} — não pode exceder ~960/dia a 90s`);
});

test("determinismo: mesma rng → saída idêntica", () => {
  const mk = () => {
    let s = 0;
    const rng = () => ((s = (s * 9301 + 49297) % 233280), s / 233280); // LCG estável
    return distributeScheduledAtsByDailyCap({
      count: 50,
      dailyCap: 12,
      intervalSeconds: 100,
      jitterSeconds: 25,
      baseStart: BASE,
      rng,
    });
  };
  const a = mk().map((d) => d.toISOString());
  const b = mk().map((d) => d.toISOString());
  assert(JSON.stringify(a) === JSON.stringify(b), "saídas divergiram com a mesma rng");
  assert(maxPerDay(mk()) <= 12, "cap violado no determinismo");
});

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
