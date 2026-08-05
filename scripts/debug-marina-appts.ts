/**
 * debug-only — apagar após diagnóstico
 *   npx tsx -r tsconfig-paths/register scripts/debug-marina-appts.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";
import { listCalendars, listCalendarEvents, getAppointment } from "@/lib/ghl/operations";

async function main() {
  const client = new GHLClient("TdmQMjj86Y3LgppiB96K", "A62s5EQj1hldOuvBEowv");
  const start = Date.now() - 90 * 86_400_000;
  const end   = Date.now() + 180 * 86_400_000;
  console.log("Janela:", new Date(start).toISOString(), "→", new Date(end).toISOString());

  // 1) Lista calendários via listCalendars (usa /calendars/ — note o trailing slash)
  const calsRes = await listCalendars(client, "A62s5EQj1hldOuvBEowv")
    .catch((e: any) => { console.log("ERRO listCalendars:", e?.message); return { calendars: [] }; });
  const calendars = calsRes.calendars || [];
  console.log(`\n${calendars.length} calendário(s):`);
  for (const c of calendars) console.log(`  ${c.id}  "${c.name}"`);

  // 2) Para cada calendário, busca eventos via listCalendarEvents
  let totalEvents = 0;
  for (const cal of calendars) {
    const evRes = await listCalendarEvents(client, {
      locationId: "A62s5EQj1hldOuvBEowv",
      calendarId: cal.id,
      startTime: String(start),
      endTime: String(end),
    }).catch((e: any) => { console.log(`  Cal "${cal.name}" ERRO:`, e?.message); return { events: [] }; });
    const evts = evRes.events || [];
    totalEvents += evts.length;
    console.log(`\nCal "${cal.name}" — ${evts.length} evento(s):`);
    for (const e of evts.slice(0, 5)) {
      console.log(`  id=${e.id}  start=${e.startTime}  "${e.title}"  status=${e.appointmentStatus}`);
    }
    // Amostra: busca detalhes do primeiro pra ver o campo address/meetingLocationType
    if (evts.length > 0) {
      const detail = await getAppointment(client, evts[0].id)
        .catch((e: any) => ({ appointment: null, __err: e?.message }));
      const a = (detail as any).appointment;
      if (a) console.log(`  → detail[0]: address="${a.address}" meetingLocationType="${a.meetingLocationType}"`);
    }
  }
  console.log(`\nTotal geral: ${totalEvents} evento(s) em ${calendars.length} calendário(s)`);
}
main().catch(console.error);
