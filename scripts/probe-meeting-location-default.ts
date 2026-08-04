/**
 * Teste empírico do local da reunião no create appointment (caso Liberty
 * Financial 2026-08-04).
 *
 * PROBLEMA: appointments criados pelo agente lead-facing nasciam com
 * `address: ""` — a automação de confirmação do GHL mandava "Local do nosso
 * encontro:" em branco. Os criados pela UI do Spark Leads vêm com o link
 * (Google Meet pro user vA6Wu…, Zoom pro Dp23a…), porque a UI respeita o
 * `locationConfigurations` do team member.
 *
 * CAUSA SUSPEITA: o action-executor mandava `meetingLocationType:"phone"` fixo
 * (sem address) quando o calendário não tinha link hardcoded — isso SOBRESCREVE
 * o default do calendário e some com o link.
 *
 * Spec oficial (apps/calendars.json do GoHighLevel/highlevel-api-docs):
 *   meetingLocationId  → default: "default"
 *   overrideLocationConfig → "false se só meetingLocationId; true se só meetingLocationType"
 * Ou seja: NÃO mandar nada = usar o default do calendário.
 *
 * Este script cria 1 appointment por variante, lê o `address` resultante e
 * DELETA.
 *
 * ⚠️ USE SÓ COM CONTATO DE TESTE: o `toNotify:false` NÃO segurou o workflow de
 * confirmação desta conta — as criações dispararam a mensagem "Local do nosso
 * encontro" pro contato (validado na rodada de 04/08). No UPDATE ele segura
 * (a cliente real cujo appointment foi curado não recebeu nada).
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-meeting-location-default.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "oEEbKRN0rQHdee13Bn1u"; // Liberty Financial
const CAL = "KyIxspeqnPjfJleMyLMz"; // 1.1 - Primeiro Encontro (round robin: gmeet + zoom)
const CONTACT = "Cj5tWqasHw1JGc2OXjRG"; // +17866276787 (contato de teste)

type Variant = { nome: string; extra: Record<string, unknown> };

const VARIANTES: Variant[] = [
  {
    nome: "A) sem campo de local (default do calendário)",
    extra: {},
  },
  {
    nome: 'B) meetingLocationId:"default" explícito',
    extra: { meetingLocationId: "default" },
  },
  {
    nome: 'C) CONTROLE — meetingLocationType:"phone" (comportamento atual, bugado)',
    extra: { meetingLocationType: "phone" },
  },
];

/**
 * Fase 2: o `book_appointment` reaproveita reunião existente com PUT. Se o PUT
 * não regenerar o local, um appointment que nasceu vazio (ou remarcado) segue
 * sem link. Cria um vazio de propósito e testa as receitas de PUT.
 */
async function fase2Put(client: GHLClient) {
  console.log("\n\n======== FASE 2 — PUT (reaproveitar reunião existente) ========");
  const start = new Date("2026-11-19T15:00:00-05:00").toISOString();
  const res = await client.post<{ id?: string; appointment?: { id?: string } }>(
    "/calendars/events/appointments",
    {
      calendarId: CAL,
      locationId: LOC,
      contactId: CONTACT,
      startTime: start,
      title: "TESTE put local",
      toNotify: false,
      assignedUserId: "vA6Wu9jJqRZ6VFK9BBNh",
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
      meetingLocationType: "phone", // nasce vazio (bug atual)
    },
  );
  const apptId = res.id || res.appointment?.id;
  if (!apptId) {
    console.log("   não consegui criar o appointment da fase 2");
    return;
  }
  const leAddr = async (tag: string) => {
    const d = await client.get<{ appointment?: Record<string, unknown> }>(
      `/calendars/events/appointments/${apptId}`,
    );
    const addr = d.appointment?.address ?? null;
    console.log(`   ${tag}: address = ${JSON.stringify(addr)} → ${addr ? "✅" : "❌ VAZIO"}`);
    return addr;
  };
  try {
    await leAddr("depois do create bugado");

    // PUT igual ao de produção hoje (sem campo de local, só horário/título)
    await client.put(`/calendars/events/appointments/${apptId}`, {
      calendarId: CAL,
      startTime: new Date("2026-11-19T16:00:00-05:00").toISOString(),
      title: "TESTE put local",
      toNotify: false,
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
    });
    await leAddr("PUT sem campo de local (produção hoje)");

    // PUT reafirmando o dono → força o GHL a re-resolver a config do membro?
    await client.put(`/calendars/events/appointments/${apptId}`, {
      calendarId: CAL,
      assignedUserId: "vA6Wu9jJqRZ6VFK9BBNh",
      toNotify: false,
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
    });
    await leAddr("PUT reafirmando assignedUserId");

    // PUT pedindo explicitamente o tipo gmeet
    await client.put(`/calendars/events/appointments/${apptId}`, {
      calendarId: CAL,
      meetingLocationType: "gmeet",
      meetingLocationId: "google_conference_0",
      overrideLocationConfig: true,
      toNotify: false,
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
    });
    await leAddr("PUT meetingLocationType=gmeet + meetingLocationId");
  } finally {
    await client
      .delete(`/calendars/events/appointments/${apptId}`)
      .catch((e) => console.log(`   (falhou ao deletar ${apptId}: ${e})`));
  }
}

async function main() {
  const client = new GHLClient(COMPANY, LOC);
  // Slot bem no futuro, fora de qualquer agenda real. ignoreFreeSlotValidation
  // igual pra todas as variantes → a comparação continua válida.
  const base = new Date("2026-11-18T15:00:00-05:00");

  for (let i = 0; i < VARIANTES.length; i++) {
    const v = VARIANTES[i];
    const start = new Date(base.getTime() + i * 3600_000).toISOString();
    let apptId: string | undefined;
    try {
      const res = await client.post<{ id?: string; appointment?: { id?: string } }>(
        "/calendars/events/appointments",
        {
          calendarId: CAL,
          locationId: LOC,
          contactId: CONTACT,
          startTime: start,
          title: `TESTE local reuniao ${i}`,
          toNotify: false, // automações NÃO rodam
          // Com ignoreFreeSlotValidation o round-robin não escolhe sozinho
          // (422 "assignedUserId is missing") — fixamos no membro do Google Meet
          // de propósito: se o default for respeitado, o address vira meet.google.com.
          assignedUserId: "vA6Wu9jJqRZ6VFK9BBNh",
          ignoreFreeSlotValidation: true,
          ignoreDateRange: true,
          ...v.extra,
        },
      );
      apptId = res.id || res.appointment?.id;
      const detail = await client.get<{ appointment?: Record<string, unknown> }>(
        `/calendars/events/appointments/${apptId}`,
      );
      const a = detail.appointment || {};
      console.log(`\n${v.nome}`);
      console.log(`   payload extra: ${JSON.stringify(v.extra)}`);
      console.log(`   assignedUserId = ${String(a.assignedUserId)}`);
      console.log(`   address        = ${JSON.stringify(a.address ?? null)}`);
      console.log(`   → ${a.address ? "✅ LOCAL PREENCHIDO" : "❌ VAZIO"}`);
    } catch (e) {
      console.log(`\n${v.nome}\n   ERRO: ${e instanceof Error ? e.message.slice(0, 300) : e}`);
    } finally {
      if (apptId) {
        await client
          .delete(`/calendars/events/appointments/${apptId}`)
          .catch((e) => console.log(`   (falhou ao deletar ${apptId}: ${e})`));
      }
    }
  }

  await fase2Put(client);
}

main().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
