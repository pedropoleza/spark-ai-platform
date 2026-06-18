/**
 * Confirma o fix: PUT com ignoreFreeSlotValidation:true (mesmo horário, sem
 * mudança real) deve PASSAR onde o PUT sem o flag falhou com "slot unavailable".
 *   npx tsx -r tsconfig-paths/register scripts/diag-erika-flag.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "../src/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "efZEjK6PqtPGDHqB2vV6";
const APPT = "OKIkFzW6u8v9ODMt9faU"; // Erika hoje 13:00 (do diag anterior)

async function main() {
  const c = new GHLClient(COMPANY, LOCATION);
  const cur = await c.get<{ event?: { startTime?: string; endTime?: string } }>(
    `/calendars/events/appointments/${APPT}`);
  const startTime = cur.event?.startTime;
  const endTime = cur.event?.endTime;
  console.log(`appt ${APPT} atual: ${startTime} → ${endTime}`);

  console.log(`\n=== PUT COM ignoreFreeSlotValidation:true (mesmo horário) ===`);
  try {
    await c.put(`/calendars/events/appointments/${APPT}`, {
      startTime, endTime, ignoreFreeSlotValidation: true,
    });
    console.log("✅ PASSOU — o flag ignoreFreeSlotValidation resolve. Bug = o flag não chegou no update.");
  } catch (e) {
    console.log(`❌ FALHOU mesmo com flag: ${e instanceof Error ? e.message : e}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("erro:", e instanceof Error ? e.message : e); process.exit(1); });
