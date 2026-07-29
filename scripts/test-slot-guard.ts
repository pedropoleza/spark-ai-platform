/**
 * Guard rail do slot-guard lead-facing (H58, caso Alves Cury). PURO, sem GHL/DB.
 *   npx tsx scripts/test-slot-guard.ts
 */
import { extractSlotIsoList, validateBookingSlot } from "../src/lib/ai/slot-guard";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log("\n=== extractSlotIsoList (shape real do GHL free-slots) ===");
const resp = {
  traceId: "abc",
  "2026-07-30": { slots: ["2026-07-30T10:00:00-04:00", "2026-07-30T10:30:00-04:00"] },
  "2026-07-31": { slots: ["2026-07-31T15:00:00-04:00"] },
};
const list = extractSlotIsoList(resp);
ok("extrai 3 slots (ignora traceId)", list.length === 3);
ok("preserva ISO", list[0] === "2026-07-30T10:00:00-04:00");
ok("null → []", extractSlotIsoList(null).length === 0);
ok("vazio → []", extractSlotIsoList({}).length === 0);
ok("dia sem slots → ignora", extractSlotIsoList({ "2026-08-01": { slots: [] } }).length === 0);

console.log("\n=== validateBookingSlot ===");
const offered = list;
ok("slot exato da lista → ok", validateBookingSlot("2026-07-30T10:00:00-04:00", offered).ok === true);
ok("MESMO instante com offset diferente (14:00Z = 10:00-04) → ok",
  validateBookingSlot("2026-07-30T14:00:00Z", offered).ok === true);
ok("30s de diferença (tolerância 60s) → ok",
  validateBookingSlot("2026-07-30T10:00:30-04:00", offered).ok === true);
const wrong = validateBookingSlot("2026-07-30T11:00:00-04:00", offered);
ok("horário fora da lista → BLOQUEIA", wrong.ok === false);
ok("…com 'horario indisponivel' (cai no isBookingConflictError)",
  !wrong.ok && wrong.reason.includes("horario indisponivel"));
const wrongTz = validateBookingSlot("2026-07-30T10:00:00-07:00", offered);
ok("wall-clock certo mas FUSO errado (bug H42) → BLOQUEIA", wrongTz.ok === false);
const wrongDay = validateBookingSlot("2026-07-29T10:00:00-04:00", offered);
ok("DIA errado (bug H50) → BLOQUEIA", wrongDay.ok === false);
const empty = validateBookingSlot("2026-07-30T10:00:00-04:00", []);
ok("lista vazia (fetch falhou/sem slots) → BLOQUEIA", empty.ok === false);
ok("…com 'horario indisponivel'", !empty.ok && empty.reason.includes("horario indisponivel"));
ok("offered undefined (caller legado) → permite", validateBookingSlot("2026-07-30T10:00:00-04:00", undefined).ok === true);
ok("sem start_time → permite (executor ignora)", validateBookingSlot(undefined, offered).ok === true);
const junk = validateBookingSlot("amanhã às 3", offered);
ok("start_time lixo → BLOQUEIA com indisponivel", junk.ok === false && junk.reason.includes("horario indisponivel"));

console.log("\n=== anti-config-keyword (não pode casar BOOKING_CONFIG_KEYWORDS) ===");
for (const v of [wrong, empty, junk]) {
  if (!v.ok) ok(`reason não contém 'nao configurado': "${v.reason.slice(0, 50)}..."`, !v.reason.includes("nao configurado"));
}

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
