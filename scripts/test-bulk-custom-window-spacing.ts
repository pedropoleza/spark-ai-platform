/**
 * Guard-rail — computeBatchedScheduledAts no custom_window.
 *
 * Fix bug observado em prod 2026-06-09 (Gustavo Couto): a janela é ENVELOPE
 * (limite), não ALVO a preencher. Antes `gap = max(interval, windowMs/total)`
 * esparramava poucos contatos pra ocupar a janela inteira — 23 contatos numa
 * janela de 9h viravam 1 a cada ~23min em vez dos 90s configurados → disparo
 * de ~10h. Estes testes travam que o gap é SEMPRE o intervalo configurado.
 *
 * jitter_seconds:0 em todos os casos pra spacing determinístico.
 */
import { computeBatchedScheduledAts } from "../src/lib/account-assistant/tools/bulk-delivery-strategy";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`); failed++; }
}
function assert(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function gapsSec(dates: Date[]): number[] {
  const g: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    g.push((dates[i].getTime() - dates[i - 1].getTime()) / 1000);
  }
  return g;
}

console.log("\n=== custom_window spacing (regressão Gustavo 2026-06-09) ===\n");

test("caso Gustavo: 23 contatos, janela 12h-21h (9h), interval 90s → gap 90s, NÃO esparrama", () => {
  const ats = computeBatchedScheduledAts({
    total_recipients: 23,
    strategy: {
      type: "custom_window",
      start_at: "2026-06-08T12:00:00-04:00",
      end_at: "2026-06-08T21:00:00-04:00",
      interval_seconds: 90,
      jitter_seconds: 0,
    },
  });
  assert(ats.length === 23, `len=${ats.length}`);
  const g = gapsSec(ats);
  assert(g.every((x) => x === 90), `gaps inesperados: ${[...new Set(g)].join(",")}`);
  const spanMin = (ats[22].getTime() - ats[0].getTime()) / 60000;
  // 22 × 90s = 1980s = 33min. NÃO as 9h da janela.
  assert(Math.round(spanMin) === 33, `span=${spanMin}min (esperava 33, bug antigo dava ~517)`);
});

test("janela larga + poucos contatos termina cedo (não preenche a janela)", () => {
  const ats = computeBatchedScheduledAts({
    total_recipients: 5,
    strategy: {
      type: "custom_window",
      start_at: "2026-06-08T12:00:00-04:00",
      end_at: "2026-06-08T20:00:00-04:00", // 8h de janela
      interval_seconds: 180, // 3min
      jitter_seconds: 0,
    },
  });
  const g = gapsSec(ats);
  assert(g.every((x) => x === 180), `gaps=${[...new Set(g)].join(",")}`);
  const spanMin = (ats[4].getTime() - ats[0].getTime()) / 60000;
  assert(spanMin === 12, `span=${spanMin}min (4 × 3min = 12, não as 8h da janela)`);
});

test("respeita interval custom (300s) independente do tamanho da janela", () => {
  const ats = computeBatchedScheduledAts({
    total_recipients: 10,
    strategy: {
      type: "custom_window",
      start_at: "2026-06-08T09:00:00-04:00",
      end_at: "2026-06-08T21:00:00-04:00",
      interval_seconds: 300,
      jitter_seconds: 0,
    },
  });
  assert(gapsSec(ats).every((x) => x === 300), "gap deveria ser 300s");
});

test("ancora no start_at da janela (não em now)", () => {
  const start = "2026-06-08T12:00:00-04:00";
  const ats = computeBatchedScheduledAts({
    total_recipients: 3,
    strategy: { type: "custom_window", start_at: start, end_at: "2026-06-08T18:00:00-04:00", interval_seconds: 90, jitter_seconds: 0 },
  });
  assert(ats[0].getTime() === new Date(start).getTime(), "primeiro envio deveria ser exatamente o start_at");
});

test("não comprime abaixo do interval mesmo se contatos não cabem na janela", () => {
  // 100 contatos × 90s = 9000s = 2.5h, mas janela só 30min. Antes/depois: gap
  // nunca cai abaixo do interval (anti-spam) — transborda o end_at.
  const ats = computeBatchedScheduledAts({
    total_recipients: 100,
    strategy: {
      type: "custom_window",
      start_at: "2026-06-08T12:00:00-04:00",
      end_at: "2026-06-08T12:30:00-04:00", // só 30min
      interval_seconds: 90,
      jitter_seconds: 0,
    },
  });
  assert(gapsSec(ats).every((x) => x === 90), "gap deveria continuar 90s (não comprime abaixo do floor)");
});

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
