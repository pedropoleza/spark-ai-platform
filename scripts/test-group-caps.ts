/**
 * Guard rail do avaliador de caps anti-ban de grupo (H46/F2). PURO, sem DB.
 *   npx tsx scripts/test-group-caps.ts
 */
import { evaluateGroupCaps, type GroupCaps } from "../src/lib/account-assistant/group-campaigns/caps";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}
const m = (o: Record<string, number>) => new Map(Object.entries(o));
const CAPS: GroupCaps = { maxGroupsPerDay: 10, maxMsgsPerGroupPerDay: 2, maxMsgsPerDayTotal: 20 };

console.log("\n=== evaluateGroupCaps ===");
ok("vazio + 3 grupos novos → ok", evaluateGroupCaps(m({}), ["a", "b", "c"], CAPS).ok === true);

const v1 = evaluateGroupCaps(m({ g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1 }), ["NOVO"], CAPS);
ok("10 grupos já + 1 novo → fail groups_per_day", v1.ok === false && v1.reason === "groups_per_day");

ok("10 grupos já + msg a um EXISTENTE (within per-group) → ok",
  evaluateGroupCaps(m({ g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1 }), ["g1"], CAPS).ok === true);

const v2 = evaluateGroupCaps(m({}), ["x", "x", "x"], CAPS);
ok("mesmo grupo 3x (cap 2/grupo) → fail msgs_per_group", v2.ok === false && v2.reason === "msgs_per_group");

const v3 = evaluateGroupCaps(m({ x: 2 }), ["x"], CAPS);
ok("grupo já com 2 + mais 1 → fail msgs_per_group", v3.ok === false && v3.reason === "msgs_per_group");

// isola msgs_per_day com caps custom (grupos/per-group altos)
const loose: GroupCaps = { maxGroupsPerDay: 100, maxMsgsPerGroupPerDay: 100, maxMsgsPerDayTotal: 5 };
const v4 = evaluateGroupCaps(m({ a: 4 }), ["b", "c"], loose);
ok("total 4 já + 2 (cap 5/dia) → fail msgs_per_day", v4.ok === false && v4.reason === "msgs_per_day");
ok("total 4 já + 1 (cap 5/dia) → ok (=5, não passa)", evaluateGroupCaps(m({ a: 4 }), ["b"], loose).ok === true);

ok("exatamente no limite de grupos (10) → ok",
  evaluateGroupCaps(m({ g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1 }), ["g10"], CAPS).ok === true);

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
