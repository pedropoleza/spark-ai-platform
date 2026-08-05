/**
 * fix-marina-appointment-zoom.ts
 *
 * Corrige o campo "Meeting Location" nos agendamentos da Marina
 * que ficaram sem o link do Zoom por um bug da IA.
 *
 * Critério de alvo: seg(1) / ter(2) / qui(4) às 20:00 ET.
 * Janela: últimos 90 dias + próximos 180 dias.
 *
 * Fase 1 (padrão = DRY-RUN): lê e lista o que seria alterado, sem tocar nada.
 * Fase 2 (--apply): faz os PUT no GHL. Confirma cada um.
 *
 *   DRY:   npx tsx -r tsconfig-paths/register scripts/fix-marina-appointment-zoom.ts
 *   APPLY: npx tsx -r tsconfig-paths/register scripts/fix-marina-appointment-zoom.ts --apply
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";
import { listCalendars, listCalendarEvents, getAppointment } from "@/lib/ghl/operations";

const COMPANY  = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "A62s5EQj1hldOuvBEowv"; // Marina
const ZOOM_URL = "https://us02web.zoom.us/j/88260482475?pwd=9SRGjNR8jvet9vxzxr6e6ErYbytYRM.1";
const TZ       = "America/New_York";
// Dias-alvo: 0=Dom 1=Seg 2=Ter 3=Qua 4=Qui 5=Sex 6=Sab
const TARGET_DAYS = new Set([1, 2, 4]);
const TARGET_HOUR = 20; // 8pm ET
const APPLY = process.argv.includes("--apply");
const DAY   = ["Dom","Seg","Ter","Qua","Qui","Sex","Sab"];

function getStartIso(a: any): string | null {
  return a.startTime ?? a.start ?? a.startDate ?? null;
}

function toET(iso: string): Date {
  return new Date(new Date(iso).toLocaleString("en-US", { timeZone: TZ }));
}

async function fetchAll(client: GHLClient): Promise<any[]> {
  // /calendars/events exige calendarId OU userId — iterar por calendário.
  // GHL não suporta limit/skip neste endpoint — uma chamada devolve tudo no range.
  const start = Date.now() - 90  * 86_400_000;
  const end   = Date.now() + 180 * 86_400_000;
  const calsRes = await listCalendars(client, LOCATION);
  const calendars = calsRes.calendars || [];
  console.log(`  ${calendars.length} calendário(s): ${calendars.map(c => `"${c.name}"`).join(", ")}`);
  const all: any[] = [];
  for (const cal of calendars) {
    const res = await listCalendarEvents(client, {
      locationId: LOCATION,
      calendarId: cal.id,
      startTime:  String(start),
      endTime:    String(end),
    }).catch(() => null);
    const batch = res?.events ?? [];
    batch.forEach(e => { (e as any)._calendarId = cal.id; });
    all.push(...batch);
  }
  return all;
}

function isTarget(a: any): boolean {
  const iso = getStartIso(a);
  if (!iso) return false;
  const dt = toET(iso);
  return TARGET_DAYS.has(dt.getDay()) && dt.getHours() === TARGET_HOUR && dt.getMinutes() === 0;
}

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  process.stdout.write("Buscando agendamentos da Marina… ");
  const all = await fetchAll(client);
  console.log(`${all.length} registos total.\n`);

  const targets = all.filter(isTarget);
  if (targets.length === 0) {
    console.log("✅ Nenhum agendamento seg/ter/qui 20:00 ET encontrado. Nada a fazer.");
    return;
  }

  const label = APPLY ? "🔄 APLICAR" : "👁️  DRY-RUN";
  console.log(`\n${label} — ${targets.length} agendamento(s) seg/ter/qui 20:00 ET:\n`);

  // Busca detalhes (address real) de cada evento — necessário pra saber o estado actual
  console.log("  Carregando detalhes…");
  type EventDetail = { id: string; iso: string; title: string; dateStr: string; addressNow: string; hasCorrect: boolean };
  const details: EventDetail[] = [];
  for (const a of targets) {
    const iso    = getStartIso(a)!;
    const dt     = toET(iso);
    const dateStr = `${DAY[dt.getDay()]} ${dt.toLocaleDateString("pt-BR")} ${dt.getHours()}:00`;
    const detail = await getAppointment(client, a.id).catch(() => null);
    const addr   = detail?.appointment?.address ?? "";
    details.push({
      id: a.id, iso, title: (a.title ?? "(sem título)").substring(0, 28),
      dateStr, addressNow: addr, hasCorrect: addr === ZOOM_URL,
    });
  }

  // cabeçalho
  console.log(
    "\n  " + "ID".padEnd(32) +
    " | " + "Data (ET)".padEnd(22) +
    " | " + "Título".padEnd(28) +
    " | Status"
  );
  console.log("  " + "─".repeat(100));
  for (const d of details) {
    const status = d.hasCorrect ? "✅ já tem o link" : (d.addressNow ? `⚠️  outro link: ${d.addressNow.slice(0,30)}` : "❌ vazio");
    console.log(`  ${d.id.padEnd(32)} | ${d.dateStr.padEnd(22)} | ${d.title.padEnd(28)} | ${status}`);
  }
  const toFix  = details.filter(d => !d.hasCorrect);
  const alrOk  = details.filter(d => d.hasCorrect);
  console.log(`\n  Resumo: ${alrOk.length} já OK / ${toFix.length} precisam de fix`);

  if (!APPLY) {
    console.log("\n⚠️  DRY-RUN concluído — nenhuma alteração feita.");
    if (toFix.length > 0) {
      console.log(`   Zoom a aplicar:\n   ${ZOOM_URL}`);
      console.log(`\n   Para aplicar de facto:\n   npx tsx -r tsconfig-paths/register scripts/fix-marina-appointment-zoom.ts --apply`);
    } else {
      console.log("   Todos os agendamentos alvo já têm o link correcto. Nada a fazer.");
    }
    return;
  }
  if (toFix.length === 0) {
    console.log("\n✅ Todos já têm o link correcto. Nada a actualizar.");
    return;
  }

  // ─── APPLY — só os que precisam de fix ───────────────────────────────────
  console.log(`\n🔄 Aplicando Zoom em ${toFix.length} agendamento(s)…\n   ${ZOOM_URL}\n`);
  let ok = 0; let fail = 0;
  for (const d of toFix) {
    try {
      // PUT minimal — só altera o meeting location.
      // CRÍTICO: overrideLocationConfig=true é obrigatório; sem ele o GHL
      // descarta silenciosamente o address/meetingLocationType (ver calendar.ts:1546).
      // Não enviar startTime/endTime/assignedUserId evita o gate 422 "assignee
      // missing" de calendários round-robin quando só queremos mudar o link.
      await client.put(`/calendars/events/appointments/${d.id}`, {
        address:                ZOOM_URL,
        meetingLocationType:    "custom",
        overrideLocationConfig: true,
      });
      console.log(`  ✅ ${d.id}  ${d.dateStr}  "${d.title}"`);
      ok++;
    } catch (e) {
      console.error(`  ❌ ${d.id}  ${e instanceof Error ? e.message : e}`);
      fail++;
    }
  }
  console.log(`\nConcluído: ${ok} alterado(s) / ${fail} falhado(s).`);
  if (fail > 0) {
    console.log("   Os que falharam NÃO foram modificados — podes re-rodar --apply para tentar de novo.");
  }
}

main().catch((e) => {
  console.error("ERRO FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
