/**
 * Read-only probe (caso Liberty Financial 2026-08-04): o agente lead-facing cria
 * appointment com "meeting location" VAZIO — a automação de confirmação do GHL
 * manda "Local do nosso encontro:" em branco (devia vir o Google Meet, que é o
 * default configurado no calendário).
 *
 * Objetivo: ver (a) como o calendário guarda o local default e (b) o que ficou
 * gravado no appointment que a IA criou.
 *   npx tsx -r tsconfig-paths/register scripts/probe-meeting-location.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "oEEbKRN0rQHdee13Bn1u"; // Liberty Financial
const CONTACT_HINT = "Marta";

async function main() {
  const client = new GHLClient(COMPANY, LOC);

  console.log("======== CALENDÁRIOS ========");
  const cals = await client.get<{
    calendars?: Array<Record<string, unknown>>;
  }>("/calendars/", { locationId: LOC });
  for (const c of cals.calendars || []) {
    console.log(`\n--- ${String(c.name)} (${String(c.id)}) ---`);
    const detail = await client
      .get<{ calendar?: Record<string, unknown> }>(`/calendars/${String(c.id)}`)
      .catch((e) => {
        console.log("  erro detail:", e instanceof Error ? e.message.slice(0, 160) : e);
        return null;
      });
    const full = detail?.calendar || c;
    for (const k of Object.keys(full)) {
      if (/location|meeting|address|link|zoom|meet|provider|conferenc/i.test(k)) {
        console.log(`  ${k} =`, JSON.stringify(full[k]));
      }
    }
  }

  console.log("\n\n======== CONTATO + APPOINTMENTS ========");
  const search = await client.get<{ contacts?: Array<{ id: string; contactName?: string; phone?: string }> }>(
    "/contacts/",
    { locationId: LOC, query: CONTACT_HINT },
  );
  for (const ct of (search.contacts || []).slice(0, 5)) {
    console.log(`\ncontato ${ct.contactName} (${ct.id}) phone=${ct.phone}`);
    let appts: Array<Record<string, unknown>> = [];
    try {
      const r = await client.get<{ events?: typeof appts }>(
        `/contacts/${ct.id}/appointments`,
      );
      appts = r.events || [];
    } catch (e) {
      console.log("  erro appointments:", e instanceof Error ? e.message.slice(0, 200) : e);
      continue;
    }
    for (const a of appts) {
      console.log(`  appt ${String(a.id)} @ ${String(a.startTime)} cal=${String(a.calendarId)}`);
      const detail = await client
        .get<{ appointment?: Record<string, unknown> }>(
          `/calendars/events/appointments/${String(a.id)}`,
        )
        .catch((e) => {
          console.log("    erro detail:", e instanceof Error ? e.message.slice(0, 160) : e);
          return null;
        });
      if (detail?.appointment) {
        console.log("    RAW:", JSON.stringify(detail.appointment));
      }
    }
  }
}

main().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
