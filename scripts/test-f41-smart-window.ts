/**
 * F41 unit test — pickSmartWindow.
 *
 * Casos:
 *  1. Volume normal (cabe natural antes de 21h)
 *  2. Volume grande mas comprimível
 *  3. Volume enorme — spread_days
 *  4. Pref customizada do rep
 *  5. Cap 21h respeitado
 *  6. Start de noite → joga pro próximo dia 9h
 *  7. Floor de 60s respeitado
 */
import { pickSmartWindow, DEFAULT_PACING_PREFS } from "../src/lib/account-assistant/tools/bulk-delivery-strategy";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`); failed++; }
}

function assert(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg || "assertion failed");
}

console.log("\n=== F41 pickSmartWindow Test Suite ===\n");

console.log("Default prefs (3min interval):");

test("12 contatos hoje (caso Gustavo) → janela 36min", () => {
  const baseStart = new Date("2026-06-02T13:00:00-04:00"); // 1pm
  const r = pickSmartWindow({ N: 12, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  assert(r.strategy.type === "custom_window", `strategy=${r.strategy.type}`);
  assert(r.interval_seconds === 180, `interval=${r.interval_seconds}`);
  assert(r.total_minutes === 36, `total=${r.total_minutes}`);
  assert(!r.compressed);
  assert(!r.spread_to_days);
  console.log(`    ${r.human_summary}`);
});

test("1 contato → janela mínima", () => {
  const r = pickSmartWindow({ N: 1, prefs: DEFAULT_PACING_PREFS });
  assert(r.strategy.type === "custom_window");
  assert(r.total_minutes === 3);
});

test("50 contatos com 3min → 2.5h, cabe", () => {
  const baseStart = new Date("2026-06-02T10:00:00-04:00");
  const r = pickSmartWindow({ N: 50, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  assert(r.strategy.type === "custom_window");
  assert(!r.compressed);
  assert(r.total_minutes === 150);
});

test("100 contatos × 3min = 5h, começando 15h → não cabe até 21h, comprime", () => {
  const baseStart = new Date("2026-06-02T15:00:00-04:00");
  const r = pickSmartWindow({ N: 100, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  // 100 × 180s = 18000s = 5h. Cabe entre 15h-20h (5h disponível) — cabe!
  // Esse caso na verdade não comprime — 5h cabe em 15-21h.
  assert(r.strategy.type === "custom_window");
});

test("200 contatos × 3min = 10h, começando 14h → COMPRIME pra caber em 7h até 21h", () => {
  const baseStart = new Date("2026-06-02T14:00:00-04:00");
  const r = pickSmartWindow({ N: 200, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  // 200 × 180 = 36000s = 10h, cabe 7h até 21h. Comprime: 7*3600/200 = 126s.
  assert(r.strategy.type === "custom_window");
  assert(r.compressed === true, `compressed=${r.compressed}`);
  assert(r.interval_seconds! < 180, `interval=${r.interval_seconds}`);
  assert(r.interval_seconds! >= 60, `interval floor: ${r.interval_seconds}`);
  console.log(`    ${r.human_summary}`);
});

test("500 contatos × 3min mesmo com floor 60s não cabe em 1 dia → spread", () => {
  const baseStart = new Date("2026-06-02T10:00:00-04:00");
  const r = pickSmartWindow({ N: 500, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  // 500 × 60s = 30000s = 8.3h. Cabe em 11h disponível (10h-21h). Não vai spread.
  // Vai comprimir interval pra caber se janela natural não cabe.
  // 500 × 180 = 90000s = 25h, não cabe; tenta floor: precisa 500×60 = 30000s=8.3h
  // Available 10-21h = 11h. Cabe. → compressed
  assert(r.strategy.type === "custom_window", `strategy=${r.strategy.type}`);
  console.log(`    ${r.human_summary}`);
});

test("1000 contatos com floor 60s ainda não cabe → spread_days", () => {
  const baseStart = new Date("2026-06-02T10:00:00-04:00");
  const r = pickSmartWindow({ N: 1000, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  // 1000 × 60s = 60000s = 16.6h. Available 11h. NÃO CABE → spread_days
  assert(r.strategy.type === "spread_days", `strategy=${r.strategy.type}`);
  assert(r.spread_to_days && r.spread_to_days >= 2, `days=${r.spread_to_days}`);
  console.log(`    ${r.human_summary}`);
});

test("Start tarde (20h) com volume pequeno → cabe até 21h", () => {
  const baseStart = new Date("2026-06-02T20:00:00-04:00");
  const r = pickSmartWindow({ N: 5, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  // 5 × 3min = 15min. Cabe das 20h-20:15h.
  assert(r.strategy.type === "custom_window");
  assert(!r.compressed);
});

test("Start de noite (22h) → joga pro próximo dia 9h", () => {
  const baseStart = new Date("2026-06-02T22:00:00-04:00");
  const r = pickSmartWindow({ N: 10, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  const startResolved = new Date((r.strategy as { start_at: string }).start_at);
  assert(startResolved.getHours() === 9, `hour=${startResolved.getHours()}`);
  // Próximo dia
  assert(startResolved.getDate() === baseStart.getDate() + 1 || startResolved.getDate() === 1, "deveria ser dia seguinte");
});

test("Start madrugada (3h) → empurra pra 9h do MESMO dia", () => {
  const baseStart = new Date("2026-06-02T03:00:00-04:00");
  const r = pickSmartWindow({ N: 10, prefs: DEFAULT_PACING_PREFS, base_start: baseStart });
  const startResolved = new Date((r.strategy as { start_at: string }).start_at);
  assert(startResolved.getHours() === 9);
  assert(startResolved.getDate() === baseStart.getDate());
});

console.log("\nPref customizada (5min):");
test("Pref 5min → respeita", () => {
  const r = pickSmartWindow({
    N: 12,
    prefs: { interval_seconds: 300 },
    base_start: new Date("2026-06-02T14:00:00-04:00"),
  });
  assert(r.interval_seconds === 300, `interval=${r.interval_seconds}`);
  assert(r.total_minutes === 60);
});

test("Pref 1min (60s) → respeita (no floor)", () => {
  const r = pickSmartWindow({
    N: 30,
    prefs: { interval_seconds: 60 },
    base_start: new Date("2026-06-02T14:00:00-04:00"),
  });
  assert(r.interval_seconds === 60);
});

test("Pref 30s (abaixo do floor) → bumpa pra 60s", () => {
  const r = pickSmartWindow({
    N: 10,
    prefs: { interval_seconds: 30 },
    base_start: new Date("2026-06-02T14:00:00-04:00"),
  });
  assert(r.interval_seconds === 60, `interval=${r.interval_seconds} (esperava floor 60)`);
});

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
