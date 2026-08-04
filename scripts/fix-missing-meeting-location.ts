/**
 * Cura reuniões FUTURAS que ficaram sem local (H65, caso Liberty Financial
 * 2026-08-04).
 *
 * Enquanto o executor mandava `meetingLocationType:"phone"` fixo, toda reunião
 * criada pelo agente lead-facing nasceu com `address: ""` — o lead recebia a
 * confirmação com "Local do nosso encontro:" em branco. O fix no código só vale
 * pras próximas; este script conserta as que já estão marcadas.
 *
 * Só mexe em reunião FUTURA e SEM local, e só por UPDATE — nunca cria nem
 * recria nada. Nunca sobrescreve local preenchido (o rep pode ter editado à
 * mão). O `toNotify:false` segura as automações no update: validado em prod
 * 04/08 — as 2 reuniões curadas no Liberty não geraram nenhuma mensagem pros
 * contatos. (No CREATE o mesmo flag NÃO segura o workflow de confirmação
 * desta conta; por isso a cura é sempre update.)
 *
 *   npx tsx -r tsconfig-paths/register scripts/fix-missing-meeting-location.ts <locationId>
 *   npx tsx -r tsconfig-paths/register scripts/fix-missing-meeting-location.ts <locationId> --apply
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";
import { healMissingMeetingLocation } from "@/lib/queue/meeting-location";

const COMPANY = "TdmQMjj86Y3LgppiB96K";

async function main() {
  const locationId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!locationId) {
    console.error("uso: fix-missing-meeting-location.ts <locationId> [--apply]");
    process.exit(1);
  }
  const client = new GHLClient(COMPANY, locationId);
  const agora = Date.now();
  const fim = agora + 120 * 86400_000; // 120 dias à frente

  const cals = await client.get<{ calendars?: Array<{ id: string; name?: string }> }>(
    "/calendars/",
    { locationId },
  );
  let vazias = 0,
    curadas = 0,
    semConfig = 0,
    erros = 0;

  for (const cal of cals.calendars || []) {
    const res = await client
      .get<{ events?: Array<{ id: string; startTime?: string }> }>("/calendars/events", {
        locationId,
        calendarId: cal.id,
        startTime: String(agora),
        endTime: String(fim),
      })
      .catch(() => null);
    const eventos = res?.events || [];
    if (!eventos.length) continue;
    console.log(`\n### ${cal.name} — ${eventos.length} reuniões futuras`);

    for (const ev of eventos) {
      const detail = await client
        .get<{ appointment?: { address?: string; startTime?: string; contactId?: string } }>(
          `/calendars/events/appointments/${ev.id}`,
        )
        .catch(() => null);
      const appt = detail?.appointment;
      if (!appt || appt.address) continue;
      vazias++;
      if (!apply) {
        console.log(`  [dry-run] SEM local: ${appt.startTime} (${ev.id})`);
        continue;
      }
      const r = await healMissingMeetingLocation(client, ev.id, cal.id);
      if (r === "filled") {
        const pos = await client
          .get<{ appointment?: { address?: string } }>(`/calendars/events/appointments/${ev.id}`)
          .catch(() => null);
        curadas++;
        console.log(`  ✅ ${appt.startTime} → ${pos?.appointment?.address || "(vazio ainda?)"}`);
      } else if (r === "unknown_config") {
        semConfig++;
        console.log(`  ⏭️  ${appt.startTime} — calendário sem config de local reconhecível`);
      } else if (r === "error") {
        erros++;
        console.log(`  ❌ ${appt.startTime} — erro ao curar`);
      }
    }
  }

  console.log(
    `\nfuturas sem local: ${vazias} | curadas: ${curadas} | sem config: ${semConfig} | erros: ${erros}`,
  );
  if (!apply && vazias > 0) console.log("(dry-run — rode com --apply pra corrigir)");
}

main().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
