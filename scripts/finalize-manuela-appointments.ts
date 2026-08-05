/**
 * One-off (Pedro autorizou 2026-06-23 "pode override, finalizar a tarefa"): cria as
 * 14 reuniões que a Manuela (admin da location teMEo79wTnlqgUgDRmaX) pediu pro
 * Calendário - Carreira da Ana Paula Lemika. O bot travava (14-de-uma-vez) e o gate
 * D1 bloqueava (admin de cliente). Faço aqui, em lote, com OVERRIDE (slots bloqueados
 * + datas futuras), atribuindo à Ana Paula (membro do calendário).
 *
 * Spec (confirmado pela rep): 30min cada, fuso America/Sao_Paulo (-03:00, sem DST).
 *   Segunda 2026-06-29 e Terça 2026-07-01.
 *
 * Uso:  DRY:    npx tsx -r tsconfig-paths/register scripts/finalize-manuela-appointments.ts
 *       CRIAR:  CONFIRM_CREATE=1 npx tsx -r tsconfig-paths/register scripts/finalize-manuela-appointments.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";
import { listCalendars, searchContactsList, createAppointment } from "../src/lib/ghl/operations";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "teMEo79wTnlqgUgDRmaX";
const OFFSET = "-03:00"; // America/Sao_Paulo, sem DST em 2026
const CAL_NAME = "Carreira"; // "Calendário - Carreira"

// hora 24h "HH:MM" → ISO com offset SP, +30min pro fim
function slot(dateISO: string, hhmm: string): { start: string; end: string } {
  const start = `${dateISO}T${hhmm}:00${OFFSET}`;
  const end = new Date(new Date(start).getTime() + 30 * 60000).toISOString();
  return { start: new Date(start).toISOString(), end };
}
const MON = "2026-06-29"; // segunda
const TUE = "2026-07-01"; // terça

interface Appt { name: string; phone: string; date: string; hhmm: string; label: string }
const APPTS: Appt[] = [
  { name: "Guilherme Lucchese", phone: "+15088082523", date: MON, hhmm: "14:00", label: "Seg 14:00" },
  { name: "Matthew Vaughn", phone: "+17045507424", date: MON, hhmm: "14:30", label: "Seg 14:30" },
  { name: "Lidiane Borges", phone: "+19548326242", date: MON, hhmm: "15:00", label: "Seg 15:00" },
  { name: "Bianca Saores", phone: "+19803392445", date: MON, hhmm: "16:00", label: "Seg 16:00" },
  { name: "Onofre Arruda", phone: "+558898398655", date: MON, hhmm: "16:30", label: "Seg 16:30" },
  { name: "John", phone: "+19546754331", date: MON, hhmm: "17:00", label: "Seg 17:00" },
  { name: "Bruna Olson", phone: "+15618093679", date: MON, hhmm: "18:30", label: "Seg 18:30" },
  { name: "Tullio Ferraz", phone: "+16106539042", date: MON, hhmm: "19:00", label: "Seg 19:00" },
  { name: "William", phone: "+15616742625", date: MON, hhmm: "19:30", label: "Seg 19:30" },
  { name: "Marcos", phone: "+15618915365", date: TUE, hhmm: "16:30", label: "Ter 16:30" },
  { name: "Cleonice", phone: "+14015454079", date: TUE, hhmm: "17:00", label: "Ter 17:00" },
  { name: "Karla", phone: "+17542732058", date: TUE, hhmm: "17:30", label: "Ter 17:30" },
  { name: "Diogo", phone: "+19452743906", date: TUE, hhmm: "18:00", label: "Ter 18:00" },
  { name: "Marlucia", phone: "+19547562857", date: TUE, hhmm: "18:30", label: "Ter 18:30" },
];

const digits = (s: unknown) => String(s || "").replace(/\D/g, "");

async function main() {
  const willCreate = process.env.CONFIRM_CREATE === "1";
  console.log(`=== FINALIZAR 14 REUNIÕES — ${willCreate ? "CRIANDO" : "DRY-RUN"} ===\n`);
  const client = new GHLClient(COMPANY, LOC);

  // 1) Calendário Carreira
  const cals = await listCalendars(client, LOC);
  const cal = (cals.calendars || []).find((c) => (c.name || "").toLowerCase().includes(CAL_NAME.toLowerCase()));
  if (!cal) { console.error("ABORTA: calendário Carreira não encontrado. Calendários:", (cals.calendars || []).map((c) => c.name)); process.exit(1); }
  console.log(`Calendário: "${cal.name}" (${cal.id}) — teamMembers: ${JSON.stringify((cal.teamMembers || []).map((t) => t.userId))}`);

  // 2) Ana Paula (assignee) via /users/
  const usersRes = await client.get<{ users?: Array<{ id: string; firstName?: string; lastName?: string; name?: string }> }>("/users/", { locationId: LOC });
  const ana = (usersRes.users || []).find((u) => {
    const full = `${u.firstName || ""} ${u.lastName || ""} ${u.name || ""}`.toLowerCase();
    return full.includes("lemika"); // "Ana Paula Lemika" aparece como "Ana Lemika"
  });
  if (!ana) { console.error("ABORTA: Ana Paula não achada nos users:", (usersRes.users || []).map((u) => u.name || `${u.firstName} ${u.lastName}`)); process.exit(1); }
  const anaInCal = (cal.teamMembers || []).some((t) => t.userId === ana.id);
  console.log(`Assignee: Ana Paula = ${ana.id} (${ana.firstName} ${ana.lastName}) — membro do Carreira? ${anaInCal}\n`);

  // 3) Resolve contatos + monta plano
  const plan: Array<Appt & { contactId?: string; resolvedName?: string; start: string; end: string }> = [];
  for (const a of APPTS) {
    const { start, end } = slot(a.date, a.hhmm);
    const sr = await searchContactsList(client, LOC, a.phone, 5);
    const want = digits(a.phone).slice(-10);
    const match = (sr.contacts || []).find((c) => digits(c.phone).slice(-10) === want) || (sr.contacts || [])[0];
    plan.push({ ...a, start, end, contactId: match?.id as string | undefined, resolvedName: match ? `${match.firstName || ""} ${match.lastName || match.contactName || ""}`.trim() : undefined });
  }
  console.log("PLANO:");
  for (const p of plan) {
    const spLocal = new Date(p.start).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
    console.log(`  ${p.label} | ${p.name} (${p.phone}) → contact=${p.contactId || "❌ NÃO ACHADO"} [${p.resolvedName || "?"}] | SP=${spLocal} | UTC=${p.start}`);
  }
  const missing = plan.filter((p) => !p.contactId);
  if (missing.length) console.log(`\n⚠️ ${missing.length} contato(s) NÃO resolvido(s): ${missing.map((m) => m.name).join(", ")}`);

  if (!willCreate) {
    console.log(`\n[DRY-RUN] ${plan.length - missing.length}/${plan.length} prontos. Rode com CONFIRM_CREATE=1 pra criar.`);
    return;
  }

  // 4) Cria com override (slot bloqueado + data futura), atribuído à Ana Paula
  console.log("\n=== CRIANDO ===");
  let ok = 0; const fails: string[] = [];
  for (const p of plan) {
    if (!p.contactId) { fails.push(`${p.name}: sem contato`); continue; }
    try {
      const res = await createAppointment(client, {
        calendarId: cal.id, locationId: LOC, contactId: p.contactId,
        startTime: p.start, endTime: p.end,
        assignedUserId: ana.id,
        title: `Reunião - ${p.name}`,
        appointmentStatus: "confirmed",
        ignoreFreeSlotValidation: true,
        ignoreDateRange: true,
      });
      const id = res.id || res.appointment?.id;
      console.log(`  ✓ ${p.label} ${p.name} → ${id}`);
      ok++;
    } catch (e: unknown) {
      const err = e as { message?: string; response?: { data?: unknown } };
      console.log(`  ✗ ${p.label} ${p.name} → ${err?.message} ${JSON.stringify(err?.response?.data || "")}`);
      fails.push(`${p.name}: ${err?.message}`);
    }
  }
  console.log(`\n=== RESULTADO: ${ok}/${plan.length} criadas ===`);
  if (fails.length) console.log("Falhas:\n - " + fails.join("\n - "));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
