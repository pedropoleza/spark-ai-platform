/**
 * re-trigger-marina-automation.ts
 *
 * Re-dispara a automação GHL dos agendamentos do calendário "Orientação em grupo"
 * da Marina que não receberam o link de Zoom — faz toggle confirmed → new → confirmed.
 *
 * Critério: calendário "Orientação em grupo", seg/ter/qui às 20:00 ET, status=confirmed.
 * Ignora agendamentos cancelados/noshow/invalid (não mexe neles).
 *
 *   DRY:   npx tsx -r tsconfig-paths/register scripts/re-trigger-marina-automation.ts
 *   APPLY: npx tsx -r tsconfig-paths/register scripts/re-trigger-marina-automation.ts --apply
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";
import { listCalendarEvents } from "@/lib/ghl/operations";

const COMPANY    = "TdmQMjj86Y3LgppiB96K";
const LOCATION   = "A62s5EQj1hldOuvBEowv"; // Marina
const CALENDAR   = "Jc2L0wqA6A2Q9AaPuyxk"; // Orientação em grupo
const TZ         = "America/New_York";
const TARGET_DAYS = new Set([1, 2, 4]); // seg, ter, qui
const TARGET_HOUR = 20;
const APPLY         = process.argv.includes("--apply");
const TEST_ONE      = process.argv.includes("--test");       // processa só 1 (o primeiro futuro)
const FROM_TOMORROW = process.argv.includes("--from-tomorrow"); // ignora hoje, só a partir de 30/06
const DAY         = ["Dom","Seg","Ter","Qua","Qui","Sex","Sab"];
const PAUSE_MS    = 1500; // pausa entre new → confirmed por agendamento

function toET(iso: string): Date {
  return new Date(new Date(iso).toLocaleString("en-US", { timeZone: TZ }));
}
function getStart(a: any): string | null {
  return a.startTime ?? a.start ?? a.startDate ?? null;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  const start  = Date.now() - 90  * 86_400_000;
  const end    = Date.now() + 180 * 86_400_000;

  process.stdout.write('Buscando "Orientação em grupo"… ');
  const res = await listCalendarEvents(client, {
    locationId: LOCATION,
    calendarId: CALENDAR,
    startTime:  String(start),
    endTime:    String(end),
  });
  const events = res.events ?? [];
  console.log(`${events.length} evento(s) total.`);

  // Filtro: dia/hora + status confirmed (não mexe em cancelled/noshow/invalid)
  const now = Date.now();
  // --from-tomorrow: start of 2026-06-30 ET (meia-noite em NY)
  const tomorrowET = new Date("2026-06-30T00:00:00-04:00").getTime();
  const minTime = TEST_ONE ? now : FROM_TOMORROW ? tomorrowET : 0;
  let targets = events.filter(e => {
    const iso = getStart(e);
    if (!iso) return false;
    const dt = toET(iso);
    const dayHourOk = TARGET_DAYS.has(dt.getDay()) && dt.getHours() === TARGET_HOUR && dt.getMinutes() === 0;
    const statusOk  = (e.appointmentStatus || "confirmed") === "confirmed";
    const dateOk    = new Date(iso).getTime() >= minTime;
    return dayHourOk && statusOk && dateOk;
  });
  if (TEST_ONE) targets = targets.slice(0, 1);

  if (targets.length === 0) {
    console.log("Nenhum agendamento confirmado seg/ter/qui 20:00 ET. Nada a fazer.");
    return;
  }

  const label = TEST_ONE ? "🧪 TESTE (1 agendamento)" : (APPLY || FROM_TOMORROW) ? "🔄 APLICAR" : "👁️  DRY-RUN";
  console.log(`\n${label} — ${targets.length} agendamento(s):\n`);
  console.log(
    "  " + "ID".padEnd(32) +
    " | " + "Data (ET)".padEnd(22) +
    " | Título"
  );
  console.log("  " + "─".repeat(90));
  for (const e of targets) {
    const iso     = getStart(e)!;
    const dt      = toET(iso);
    const dateStr = `${DAY[dt.getDay()]} ${dt.toLocaleDateString("pt-BR")} ${dt.getHours()}:00`;
    console.log(`  ${e.id.padEnd(32)} | ${dateStr.padEnd(22)} | ${(e.title ?? "(sem título)").substring(0, 35)}`);
  }

  if (!APPLY && !TEST_ONE && !FROM_TOMORROW) {
    console.log(`\n⚠️  DRY-RUN — nenhuma alteração feita.`);
    console.log(`   Teste 1 agendamento:          ... --test`);
    console.log(`   Aplicar a partir de amanhã:   ... --from-tomorrow`);
    console.log(`   Aplicar todos:                ... --apply`);
    return;
  }

  // ─── APPLY / TEST ─────────────────────────────────────────────────────────
  const modeLabel = TEST_ONE ? "TESTE" : "TOGGLE";
  console.log(`\n🔄 ${modeLabel} confirmed → new → confirmed em ${targets.length} agendamento(s)…\n`);
  let ok = 0; let fail = 0;
  for (const e of targets) {
    const iso     = getStart(e)!;
    const dt      = toET(iso);
    const dateStr = `${DAY[dt.getDay()]} ${dt.toLocaleDateString("pt-BR")} ${dt.getHours()}:00`;
    try {
      // 1) → new
      await client.put(`/calendars/events/appointments/${e.id}`, {
        appointmentStatus: "new",
      });
      await sleep(PAUSE_MS);
      // 2) → confirmed (re-trigger da automação)
      await client.put(`/calendars/events/appointments/${e.id}`, {
        appointmentStatus: "confirmed",
      });
      console.log(`  ✅ ${e.id}  ${dateStr}  "${(e.title ?? "").substring(0, 30)}"`);
      ok++;
    } catch (err) {
      console.error(`  ❌ ${e.id}  ${dateStr}  ${err instanceof Error ? err.message : err}`);
      fail++;
    }
  }
  console.log(`\nConcluído: ${ok} OK  /  ${fail} falharam.`);
  if (fail > 0) console.log("   Os que falharam ficaram como estavam — podes re-rodar --apply.");
}

main().catch(e => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
