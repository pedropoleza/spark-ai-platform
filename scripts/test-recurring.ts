/**
 * Test recurring campaigns runtime (Etapa 4.5 — Pedro 2026-05-28).
 *
 * Smoke pra:
 *   - Flag-gate RECURRING_CAMPAIGNS_ENABLED default OFF.
 *   - cron-evaluator computeNextRunAt em diferentes presets/timezones.
 *   - shouldFireCron continua válido (regressão).
 *
 * Rodar: `npx tsx scripts/test-recurring.ts`
 */
import { processRecurringTick } from "../src/lib/account-assistant/proactive/recurring-runner";
import {
  computeNextRunAt,
  previewNextRuns,
  shouldFireCron,
} from "../src/lib/account-assistant/proactive/cron-evaluator";

type Assertion = { name: string; ok: boolean; message: string };
const results: Assertion[] = [];

function assert(name: string, condition: boolean, msg: string) {
  results.push({ name, ok: condition, message: msg });
}

async function main() {
  // ── 1. Flag-gate ───────────────────────────────────────────────────────
  delete process.env.RECURRING_CAMPAIGNS_ENABLED;
  const flagOff = await processRecurringTick();
  assert(
    "flag OFF → no-op",
    flagOff.scanned === 0 && flagOff.fired === 0 && flagOff.errors === 0,
    `esperado zeros, scanned=${flagOff.scanned} fired=${flagOff.fired}`,
  );

  // ── 2. computeNextRunAt — preset "toda seg 9am" em UTC ─────────────────
  // Sample: now = quarta 8h UTC → próximo seg 9am UTC
  const fromWed = new Date("2026-06-03T08:00:00Z"); // quarta
  const nextMonday = computeNextRunAt("0 9 * * 1", "UTC", fromWed);
  assert(
    "computeNextRunAt: seg 9am UTC retornou data",
    nextMonday !== null,
    `recebeu ${nextMonday?.toISOString() ?? "null"}`,
  );
  if (nextMonday) {
    const weekday = nextMonday.getUTCDay(); // 1 = monday
    const hour = nextMonday.getUTCHours();
    assert(
      "computeNextRunAt: dia é segunda + hora 9",
      weekday === 1 && hour === 9,
      `weekday=${weekday}, hour=${hour}`,
    );
  }

  // ── 3. previewNextRuns: 5 próximos disparos espaçados por semana ──────
  const preview = previewNextRuns("0 9 * * 1", "UTC", 5, fromWed);
  assert(
    "previewNextRuns: 5 datas",
    preview.length === 5,
    `recebeu ${preview.length} datas`,
  );
  // Cada um 7 dias após o anterior
  if (preview.length === 5) {
    const deltas = preview.slice(1).map((d, i) => d.getTime() - preview[i].getTime());
    const allWeekApart = deltas.every((d) => d === 7 * 24 * 60 * 60 * 1000);
    assert(
      "previewNextRuns: cada uma 7d após anterior",
      allWeekApart,
      `deltas em ms: ${deltas.join(", ")}`,
    );
  }

  // ── 4. shouldFireCron: regressão ──────────────────────────────────────
  // Quarta 09:00 UTC NÃO deve disparar cron "0 9 * * 1" (segunda)
  const wed9am = new Date("2026-06-03T09:00:00Z");
  assert(
    "shouldFireCron: quarta 9am NÃO bate 'seg 9am'",
    shouldFireCron("0 9 * * 1", "UTC", wed9am) === false,
    "esperado false",
  );
  // Segunda 09:00 UTC DEVE disparar
  const mon9am = new Date("2026-06-08T09:00:00Z"); // segunda
  assert(
    "shouldFireCron: seg 9am bate 'seg 9am'",
    shouldFireCron("0 9 * * 1", "UTC", mon9am) === true,
    "esperado true",
  );

  // ── 5. Cron inválido → null ────────────────────────────────────────────
  const badCron = computeNextRunAt("invalid", "UTC");
  assert(
    "computeNextRunAt: cron inválido → null",
    badCron === null,
    `recebeu ${badCron}`,
  );

  // ── 6. Timezone diferente — São Paulo vs UTC ──────────────────────────
  // "0 9 * * 1" em America/Sao_Paulo (UTC-3) = 12:00 UTC na segunda
  const fromBrt = new Date("2026-06-03T08:00:00Z"); // quarta UTC = quarta 5h BRT
  const nextMonBrt = computeNextRunAt("0 9 * * 1", "America/Sao_Paulo", fromBrt);
  if (nextMonBrt) {
    const hourUtc = nextMonBrt.getUTCHours();
    // BRT é UTC-3 (sem horário de verão atualmente) → 9am BRT = 12pm UTC
    assert(
      "computeNextRunAt: 9am BRT = 12pm UTC (segunda)",
      hourUtc === 12,
      `hour UTC=${hourUtc}`,
    );
  }

  // ── Resultado ──────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  console.log(`\n${passed}/${results.length} testes passaram`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}: ${r.message}`);
  }
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test-recurring] crashed:", err);
  process.exit(1);
});
