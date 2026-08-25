// H80 — teste do knob slot_window_days (default 7, teto 31, piso 1).
// npx tsx scripts/test-slot-window.ts
import { slotWindowDays } from "@/lib/queue/slot-window";

const cases: Array<[unknown, number, string]> = [
  [{ slot_window_days: 14 }, 14, "valor válido passa (Marina)"],
  [{ slot_window_days: 31 }, 31, "teto 31 aceito"],
  [{ slot_window_days: 45 }, 7, "acima do teto (GHL recusa >31) → default"],
  [{ slot_window_days: 0 }, 7, "zero → default"],
  [{ slot_window_days: -3 }, 7, "negativo → default"],
  [{ slot_window_days: 14.9 }, 14, "fração trunca"],
  [{ slot_window_days: null }, 7, "null → default"],
  [{}, 7, "ausente → default"],
  [null, 7, "config null → default"],
  [undefined, 7, "config undefined → default"],
  [{ slot_window_days: Number.NaN }, 7, "NaN → default"],
  [{ slot_window_days: "14" }, 7, "string não passa → default"],
];

let fail = 0;
for (const [input, expected, label] of cases) {
  const got = slotWindowDays(input as { slot_window_days?: number | null } | null | undefined);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}: got=${got} expected=${expected}`);
}
console.log(fail === 0 ? `\n✅ ${cases.length}/${cases.length}` : `\n❌ ${fail} falha(s)`);
process.exit(fail === 0 ? 0 : 1);
