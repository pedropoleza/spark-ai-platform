/**
 * Agendamento de TESTE ao vivo (H65, pedido do Pedro 2026-08-04).
 *
 * Reproduz EXATAMENTE o payload que o `action-executor` passa a mandar no
 * `book_appointment` depois do fix (nenhum campo de local → o Spark Leads
 * aplica o default do calendário) e confere o `address` resultante.
 *
 * Diferente do probe, aqui as automações RODAM (sem `toNotify:false`) — é isso
 * que valida a ponta final: a mensagem de confirmação com "Local do nosso
 * encontro" preenchido chegando no WhatsApp do contato de teste.
 *
 *   npx tsx -r tsconfig-paths/register scripts/live-test-booking-liberty.ts        # dry-run
 *   npx tsx -r tsconfig-paths/register scripts/live-test-booking-liberty.ts --apply
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";
import { resolveMeetingLocation } from "@/lib/queue/meeting-links";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "oEEbKRN0rQHdee13Bn1u"; // Liberty Financial
const CAL = "KyIxspeqnPjfJleMyLMz"; // 1.1 - Primeiro Encontro
const CONTACT = "Cj5tWqasHw1JGc2OXjRG"; // +1 786 627-6787

async function main() {
  const apply = process.argv.includes("--apply");
  const client = new GHLClient(COMPANY, LOC);

  // 1. O calendário do Liberty NÃO está no mapa de links fixos (caso Marina) —
  //    é justamente o caminho que mandava "phone" e apagava o local.
  const fixo = resolveMeetingLocation(CAL);
  console.log(`resolveMeetingLocation("${CAL}") = ${JSON.stringify(fixo)}`);
  if (fixo !== null) {
    console.log("⚠️  esse calendário tem link fixo mapeado — não é o caminho do bug");
  }

  // 2. Próximo slot livre de verdade (o executor não força slot).
  const inicio = Date.now() + 24 * 3600_000;
  const fim = inicio + 10 * 86400_000;
  const slots = await client.get<Record<string, unknown>>(`/calendars/${CAL}/free-slots`, {
    startDate: String(inicio),
    endDate: String(fim),
  });
  const dias = Object.keys(slots).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
  let slot: string | undefined;
  for (const d of dias) {
    const s = (slots[d] as { slots?: string[] })?.slots;
    if (s?.length) {
      slot = s[0];
      break;
    }
  }
  if (!slot) {
    console.error("sem free-slot nos próximos 10 dias — abortando");
    process.exit(1);
  }
  console.log(`slot livre escolhido: ${slot}`);

  // 3. Payload IDÊNTICO ao do executor pós-fix.
  const payload = {
    calendarId: CAL,
    locationId: LOC,
    contactId: CONTACT,
    startTime: slot,
    title: "TESTE Spark — local da reunião",
    ...(fixo ?? {}),
  };
  console.log(`payload: ${JSON.stringify(payload)}`);
  if (!apply) {
    console.log("\n(dry-run — rode com --apply pra criar de verdade)");
    return;
  }

  const res = await client.post<{ id?: string; appointment?: { id?: string } }>(
    "/calendars/events/appointments",
    payload,
  );
  const id = res.id || res.appointment?.id;
  const detail = await client.get<{ appointment?: Record<string, unknown> }>(
    `/calendars/events/appointments/${id}`,
  );
  const a = detail.appointment || {};
  console.log(`\nappointment ${id}`);
  console.log(`  startTime      = ${String(a.startTime)}`);
  console.log(`  assignedUserId = ${String(a.assignedUserId)}`);
  console.log(`  address        = ${JSON.stringify(a.address ?? null)}`);
  console.log(`\n${a.address ? "✅ LOCAL PREENCHIDO" : "❌ AINDA VAZIO"}`);
}

main().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
