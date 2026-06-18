/**
 * Diagnóstico do erro de reagendamento (Erika Barbosa, +1 561-816-1460) 2026-06-15.
 * READ-ONLY + 1 PUT BENIGNO (re-envia o MESMO start/end → não muda nada) só pra
 * capturar a mensagem de erro crua do GHL. NÃO deleta nada.
 *   npx tsx -r tsconfig-paths/register scripts/diag-erika-appt.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "../src/lib/ghl/client";
import { getCalendarDetails } from "../src/lib/ghl/operations";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "efZEjK6PqtPGDHqB2vV6";
const ERIKA_PHONE = "5618161460";

async function main() {
  const c = new GHLClient(COMPANY, LOCATION);

  // 1) Erika
  const cs = await c.get<{ contacts?: Array<{ id: string; firstName?: string; lastName?: string }> }>(
    "/contacts/", { locationId: LOCATION, query: ERIKA_PHONE, limit: "1" });
  const erika = (cs.contacts || [])[0];
  if (!erika) { console.log("❌ Erika não achada"); process.exit(1); }
  console.log(`Erika: ${erika.id} (${erika.firstName} ${erika.lastName || ""})`);

  // 2) Appointments dela
  const ap = await c.get<{ events?: Array<Record<string, unknown>> }>(
    `/contacts/${erika.id}/appointments`);
  const appts = ap.events || [];
  console.log(`Appointments: ${appts.length}`);
  for (const a of appts) {
    console.log(`  - id=${a.id} cal=${a.calendarId} assignedUserId=${a.assignedUserId ?? "(none)"} status=${a.appointmentStatus} start=${a.startTime}`);
  }
  if (appts.length === 0) { console.log("sem appts; nada a diagnosticar"); process.exit(0); }

  // 3) Time members do calendário de cada appt
  const calIds = Array.from(new Set(appts.map((a) => String(a.calendarId)).filter(Boolean)));
  const calTeam: Record<string, string[]> = {};
  for (const cal of calIds) {
    try {
      const det = await getCalendarDetails(c, cal);
      const members = (det.calendar?.teamMembers || []).map((m) => String(m.userId));
      calTeam[cal] = members;
      console.log(`Calendário ${cal} "${det.calendar?.name}" team: [${members.join(", ") || "VAZIO"}]`);
    } catch (e) {
      console.log(`Calendário ${cal}: erro ao buscar detalhes — ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }

  // 4) assignedUserId está no time?
  for (const a of appts) {
    const team = calTeam[String(a.calendarId)] || [];
    const uid = a.assignedUserId ? String(a.assignedUserId) : "";
    const onTeam = uid && team.includes(uid);
    console.log(`  appt ${a.id}: assignedUser ${uid || "(none)"} ${uid ? (onTeam ? "✅ no time" : "❌ FORA do time do calendário") : "(sem user)"}`);
  }

  // 5) Reproduz: PUT BENIGNO (mesmo start/end) p/ capturar o erro cru
  const target = appts[0];
  console.log(`\n=== PUT benigno em ${target.id} (mesmo start/end, sem mudança) ===`);
  try {
    await c.put(`/calendars/events/appointments/${target.id}`, {
      startTime: target.startTime, endTime: target.endTime,
    });
    console.log("✅ PUT benigno PASSOU — o update funciona agora (erro original pode ter sido transitório/slot).");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`❌ PUT benigno FALHOU — erro cru do GHL:\n${msg}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("diag erro:", e instanceof Error ? e.message : e); process.exit(1); });
