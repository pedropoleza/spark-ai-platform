/**
 * Backfill do LINK de reunião nos appointments da Marina (Pedro 2026-06-28).
 * Os appointments do encontro nasciam SEM link (address vazio) → a automação de
 * confirmação do GHL não tinha o que entregar. Aqui setamos o `address` (link
 * único do encontro) em todos os appointments seg/ter/qui às 20:00 (8PM ET) que
 * ainda não têm.
 *
 * Filtro tz-aware OBRIGATÓRIO: 8PM ET = 00:00 UTC (EDT/verão) ou 01:00 UTC
 * (EST/inverno) → getHours()/getDay() (UTC no Vercel/Node) dariam dia/hora
 * errados. Por isso usa Intl com timeZone America/New_York (DST-correto).
 *
 *   DRY (só lista):  npx tsx -r tsconfig-paths/register scripts/backfill-marina-meeting-link.ts
 *   APLICA:          APPLY=1 npx tsx -r tsconfig-paths/register scripts/backfill-marina-meeting-link.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { listCalendarEvents, getAppointment, updateAppointment } from "@/lib/ghl/operations";
import { meetingLinkForCalendar } from "@/lib/queue/meeting-links";

const MARINA_LOC = "A62s5EQj1hldOuvBEowv";
const CAL = "Jc2L0wqA6A2Q9AaPuyxk";
const TZ = "America/New_York";
const HORIZON_DAYS = 90;
const APPLY = /^(1|true|yes)$/i.test(process.env.APPLY?.trim() || "");

// seg=Mon, ter=Tue, qui=Thu
const WANT_WEEKDAYS = new Set(["Mon", "Tue", "Thu"]);

function etParts(iso: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short", hour: "numeric", hour12: false, timeZone: TZ,
  }).formatToParts(new Date(iso));
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || "-1");
  return { weekday, hour: hour === 24 ? 0 : hour };
}
const fmtET = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ,
  });

async function main() {
  const link = meetingLinkForCalendar(CAL);
  if (!link) throw new Error(`Sem link configurado pro calendar ${CAL} em meeting-links.ts`);

  const sb = createAdminClient();
  const { data: loc } = await sb
    .from("locations").select("company_id").eq("location_id", MARINA_LOC).maybeSingle();
  if (!loc?.company_id) throw new Error("Sem company_id pra location");
  const client = new GHLClient(loc.company_id, MARINA_LOC);

  const now = Date.now();
  const end = now + HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const { events } = await listCalendarEvents(client, {
    locationId: MARINA_LOC, calendarId: CAL, startTime: String(now), endTime: String(end),
  });
  console.log(`[backfill] modo=${APPLY ? "APPLY" : "DRY-RUN"} · ${events?.length ?? 0} appointments no horizonte ${HORIZON_DAYS}d`);

  let matched = 0, alreadySet = 0, toUpdate = 0, updated = 0, off2000 = 0;
  let sampledType = false;

  for (const ev of events || []) {
    const { weekday, hour } = etParts(ev.startTime);
    const isTarget = WANT_WEEKDAYS.has(weekday) && hour === 20;
    if (!WANT_WEEKDAYS.has(weekday)) continue; // fora de seg/ter/qui: ignora
    if (hour !== 20) { off2000++; console.log(`  ⚠️ FORA das 20:00 (${weekday} h=${hour}) [${ev.id}] ${fmtET(ev.startTime)} — REVISAR, não toco`); continue; }
    if (!isTarget) continue;
    matched++;

    // Lê o estado atual (address + type) pra decidir e pra espelhar o type dos que já funcionam.
    let appt: Awaited<ReturnType<typeof getAppointment>>["appointment"] | undefined;
    try { appt = (await getAppointment(client, ev.id)).appointment; } catch { /* segue com listCalendarEvents */ }
    const curAddr = appt?.address ?? "";
    const curType = appt?.meetingLocationType ?? "?";

    if (!sampledType && curAddr) {
      console.log(`  [amostra c/ link] [${ev.id}] type=${curType} addr=${curAddr.slice(0, 60)}…`);
      sampledType = true;
    }

    if (curAddr === link) { alreadySet++; continue; }
    toUpdate++;
    console.log(`  ${APPLY ? "UPDATE" : "would-update"} [${ev.id}] ${fmtET(ev.startTime)} type=${curType} addr="${curAddr}"`);

    if (APPLY) {
      await updateAppointment(client, ev.id, {
        address: link,
        meetingLocationType: "custom",
        overrideLocationConfig: true,
      });
      updated++;
    }
  }

  console.log(`\n[backfill] resumo: matched(seg/ter/qui 20:00)=${matched} · já com link=${alreadySet} · ${APPLY ? `atualizados=${updated}` : `a atualizar=${toUpdate}`} · fora-20:00=${off2000}`);
  if (!APPLY) console.log("DRY-RUN: nada gravado. Rode com APPLY=1 pra aplicar.");
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
