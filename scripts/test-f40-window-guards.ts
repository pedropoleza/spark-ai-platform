/**
 * F40 unit test — cap 21h + greeting/window mismatch.
 * Como as funções helper são internas em bulk-messages-v2.ts, replico aqui
 * pra teste isolado. Manter sync com a versão runtime.
 */

interface ClampResult { adjusted: string; wasClamped: boolean; originalHour: number; }
function clampEndAtTo9PM(endAtIso: string): ClampResult {
  const m = endAtIso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)([+-]\d{2}:?\d{2}|Z)?$/);
  if (!m) return { adjusted: endAtIso, wasClamped: false, originalHour: -1 };
  const [, date, hh, mm, , tz = ""] = m;
  const hourLocal = parseInt(hh, 10);
  const minLocal = parseInt(mm, 10);
  if (hourLocal > 21 || (hourLocal === 21 && minLocal > 0)) {
    return { adjusted: `${date}T21:00:00${tz}`, wasClamped: true, originalHour: hourLocal };
  }
  return { adjusted: endAtIso, wasClamped: false, originalHour: hourLocal };
}

interface GreetingCheck { mismatch: boolean; reason?: string; }
function detectGreetingMismatch(template: string, startAtIso: string, endAtIso: string): GreetingCheck {
  const norm = (template || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const hasBomDia = /\bbom dia\b/.test(norm);
  const hasBoaTarde = /\bboa tarde\b/.test(norm);
  const hasBoaNoite = /\bboa noite\b/.test(norm);
  if (!hasBomDia && !hasBoaTarde && !hasBoaNoite) return { mismatch: false };

  const startHour = parseInt(startAtIso.match(/T(\d{2}):/)?.[1] || "0", 10);
  const endHour = parseInt(endAtIso.match(/T(\d{2}):/)?.[1] || "0", 10);
  if (hasBomDia && endHour >= 12) return { mismatch: true, reason: "bom dia + end >=12" };
  if (hasBoaTarde && (startHour < 12 || endHour > 18)) return { mismatch: true, reason: "boa tarde fora 12-18" };
  if (hasBoaNoite && startHour < 18) return { mismatch: true, reason: "boa noite + start <18" };
  return { mismatch: false };
}

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`); failed++; }
}

function eq<T>(a: T, b: T, label?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label || ""}\n    actual: ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
  }
}

console.log("\n=== F40 Test Suite ===\n");

console.log("clampEndAtTo9PM:");
test("end_at 23:59 → clamp 21:00 (caso Gustavo)", () => {
  const r = clampEndAtTo9PM("2026-06-01T23:59:00-04:00");
  eq(r.adjusted, "2026-06-01T21:00:00-04:00");
  eq(r.wasClamped, true);
  eq(r.originalHour, 23);
});
test("end_at 22:00 → clamp 21:00", () => {
  const r = clampEndAtTo9PM("2026-06-01T22:00:00-04:00");
  eq(r.wasClamped, true);
});
test("end_at 21:00 → não clampa", () => {
  const r = clampEndAtTo9PM("2026-06-01T21:00:00-04:00");
  eq(r.wasClamped, false);
});
test("end_at 21:01 → clampa", () => {
  const r = clampEndAtTo9PM("2026-06-01T21:01:00-04:00");
  eq(r.wasClamped, true);
});
test("end_at 18:00 → não clampa", () => {
  const r = clampEndAtTo9PM("2026-06-01T18:00:00-04:00");
  eq(r.wasClamped, false);
});
test("end_at 02:00 (madrugada literal) → não clampa (interpretação literal)", () => {
  // Caso edge: rep manda 02:00 literal. Não é "madrugada do dia seguinte" —
  // é 2h da manhã. Se chegou aqui, é responsabilidade do bot validar antes.
  // Cap só impede valores >21.
  const r = clampEndAtTo9PM("2026-06-01T02:00:00-04:00");
  eq(r.wasClamped, false);
});
test("preserva timezone offset", () => {
  const r = clampEndAtTo9PM("2026-06-01T23:59:00-03:00");
  eq(r.adjusted, "2026-06-01T21:00:00-03:00");
});
test("aceita Z (UTC)", () => {
  const r = clampEndAtTo9PM("2026-06-01T23:59:00Z");
  eq(r.adjusted, "2026-06-01T21:00:00Z");
});

console.log("\ndetectGreetingMismatch:");
test('"Bom dia" + janela 12-21h → mismatch', () => {
  const r = detectGreetingMismatch("Bom dia ☀️ {first_name}", "2026-06-01T12:00:00-04:00", "2026-06-01T21:00:00-04:00");
  eq(r.mismatch, true);
});
test('"Bom dia" + janela 8-11h → OK', () => {
  const r = detectGreetingMismatch("Bom dia ☀️ {first_name}", "2026-06-01T08:00:00-04:00", "2026-06-01T11:00:00-04:00");
  eq(r.mismatch, false);
});
test('"Oi" + janela 12-21h → OK (sem cumprimento)', () => {
  const r = detectGreetingMismatch("Oi {first_name}, tudo certo?", "2026-06-01T12:00:00-04:00", "2026-06-01T21:00:00-04:00");
  eq(r.mismatch, false);
});
test('"Boa tarde" + janela 9-15h → mismatch (começa cedo demais)', () => {
  const r = detectGreetingMismatch("Boa tarde {first_name}", "2026-06-01T09:00:00-04:00", "2026-06-01T15:00:00-04:00");
  eq(r.mismatch, true);
});
test('"Boa tarde" + janela 14-17h → OK', () => {
  const r = detectGreetingMismatch("Boa tarde {first_name}", "2026-06-01T14:00:00-04:00", "2026-06-01T17:00:00-04:00");
  eq(r.mismatch, false);
});
test('"Boa noite" + janela 19-21h → OK', () => {
  const r = detectGreetingMismatch("Boa noite {first_name}", "2026-06-01T19:00:00-04:00", "2026-06-01T21:00:00-04:00");
  eq(r.mismatch, false);
});
test('"Boa noite" + janela 12-21h → mismatch (começa cedo)', () => {
  const r = detectGreetingMismatch("Boa noite {first_name}", "2026-06-01T12:00:00-04:00", "2026-06-01T21:00:00-04:00");
  eq(r.mismatch, true);
});
test('acentos/case: "BOM DIA" → detect', () => {
  const r = detectGreetingMismatch("BOM DIA  {first_name}", "2026-06-01T10:00:00-04:00", "2026-06-01T21:00:00-04:00");
  eq(r.mismatch, true);
});
test('"bom dia" embutido em texto: detect', () => {
  const r = detectGreetingMismatch("Oi, bom dia, tudo bem?", "2026-06-01T10:00:00-04:00", "2026-06-01T18:00:00-04:00");
  eq(r.mismatch, true);
});

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
