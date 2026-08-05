/**
 * Teste H66 — coerção do offset do start_time pro fuso da conta (caso +1 267 746,
 * Five Star 2026-08-04: LLM falou "1 PM ET" e emitiu -03:00 → agenda 1h deslocada).
 * Rodar: npx tsx scripts/test-h66-offset-guard.ts
 */
import { coerceStartTimeToTimezone, validateBookingSlot, isSameSlotInstant } from "../src/lib/ai/slot-guard";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const NY = "America/New_York";

console.log("\nCaso real de prod (2026-08-04, EDT = -04:00)");
const real = coerceStartTimeToTimezone("2026-08-04T13:00:00-03:00", NY);
check("offset -03:00 → -04:00 (wall-clock preservado)", real.iso === "2026-08-04T13:00:00-04:00" && real.coerced, real.iso);
check("original preservado pro log", real.original === "2026-08-04T13:00:00-03:00");
check("instante corrigido = 1 PM ET de verdade", Date.parse(real.iso) === Date.parse("2026-08-04T17:00:00Z"));

console.log("\nOffset já correto = no-op");
const ok = coerceStartTimeToTimezone("2026-08-04T13:00:00-04:00", NY);
check("não marca coerced", !ok.coerced && Date.parse(ok.iso) === Date.parse("2026-08-04T13:00:00-04:00"));

console.log("\nVariantes que o LLM pode emitir");
const z = coerceStartTimeToTimezone("2026-08-04T13:00:00Z", NY);
check("Z (UTC) → wall-clock reinterpretado no fuso da conta", z.iso === "2026-08-04T13:00:00-04:00" && z.coerced);
const noOff = coerceStartTimeToTimezone("2026-08-04T13:00:00", NY);
check("sem offset → ganha o offset da conta", noOff.iso === "2026-08-04T13:00:00-04:00");
const noSec = coerceStartTimeToTimezone("2026-08-04T13:00-03:00", NY);
check("sem segundos → normaliza com :00", noSec.iso === "2026-08-04T13:00:00-04:00");
const plus = coerceStartTimeToTimezone("2026-08-04T13:00:00+00:00", NY);
check("+00:00 → reinterpretado", plus.iso === "2026-08-04T13:00:00-04:00" && plus.coerced);

console.log("\nDST (inverno = EST -05:00)");
const inverno = coerceStartTimeToTimezone("2026-01-15T13:00:00-03:00", NY);
check("janeiro → -05:00 (EST)", inverno.iso === "2026-01-15T13:00:00-05:00", inverno.iso);
const dstEdgeSpring = coerceStartTimeToTimezone("2026-03-08T07:00:00-03:00", NY);
check("borda spring-forward (08/03 7h wall) resolve sem NaN", /-0[45]:00$/.test(dstEdgeSpring.iso), dstEdgeSpring.iso);

console.log("\nOutros fusos de conta");
const chicago = coerceStartTimeToTimezone("2026-08-04T13:00:00-03:00", "America/Chicago");
check("America/Chicago → -05:00 (CDT)", chicago.iso === "2026-08-04T13:00:00-05:00", chicago.iso);

console.log("\nEntrada inválida passa intocada (slot-guard rejeita depois)");
const inv = coerceStartTimeToTimezone("banana", NY);
check("não-ISO → intocado, não coerced", inv.iso === "banana" && !inv.coerced);
const vazio = coerceStartTimeToTimezone(undefined, NY);
check("undefined → string vazia, não coerced", vazio.iso === "" && !vazio.coerced);

console.log("\nIntegração com o guard H58 (o cenário completo do caso)");
// Slots reais do turno: 1 PM ET e 3 PM ET. O LLM fala "1 PM" mas emite -03:00
// (que seria 12 PM ET = slot INEXISTENTE aqui → antes, se 12 PM fosse livre,
// bookava errado; com a coerção, vira exatamente o slot falado).
const offered = ["2026-08-04T13:00:00-04:00", "2026-08-04T15:00:00-04:00"];
const emitido = coerceStartTimeToTimezone("2026-08-04T13:00:00-03:00", NY).iso;
check("coagido casa o slot FALADO no guard", validateBookingSlot(emitido, offered).ok === true);
check("coagido é o MESMO instante do slot oferecido", isSameSlotInstant(emitido, offered[0]));
check("sem coerção, o ISO errado apontava pra OUTRO instante", !isSameSlotInstant("2026-08-04T13:00:00-03:00", offered[0]));

console.log(`\n${pass}/${pass + fail} passaram${fail ? " — FALHAS" : ""}`);
process.exit(fail ? 1 : 0);
