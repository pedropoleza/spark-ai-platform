/**
 * Read-only: forense dos casos de agendamento reportados pela Márcia (Five Star
 * Ricos) e pela Luciana, listados em spark-os/_planning/sessoes/PROMPT_IA_AGENDAMENTO.md.
 * Pra CADA telefone: resolve o contato no Spark Leads, lista TODOS os
 * appointments (com status e timestamps) e cruza com o execution_log da
 * plataforma (o que a IA tentou fazer, quando e com que resultado).
 *
 * NÃO escreve nada.
 *
 *   npx tsx -r tsconfig-paths/register scripts/forense-agendamento-marcia.ts [telefone]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";

const FIVE_STAR = "jA6uzx6tONyTeocxw4Cj";
const LUCIANA = "l02PcA5r4TL2umdwpWgn";

const CASOS: { phone: string; loc: string; caso: string }[] = [
  { phone: "+15086657240", loc: FIVE_STAR, caso: "C: 05/08 13:28 — agendou hoje E amanhã (cancelou antes?)" },
  { phone: "+15085609151", loc: FIVE_STAR, caso: "C: 06/08 14:55 — cancelou, mandou confirmação de novo" },
  { phone: "+14705602586", loc: FIVE_STAR, caso: "C: 06/08 14:56 — continuação do mesmo caso" },
  { phone: "+12677460787", loc: FIVE_STAR, caso: "B: 04/08 16:06 — falou um horário, agenda tinha outro" },
  { phone: "+19785029284", loc: FIVE_STAR, caso: "B: 06/08 17:26 — diz que nada disponível E marca" },
  { phone: "+12035192927", loc: FIVE_STAR, caso: "B: 06/08 17:40 — agendou, depois disse que não tinha" },
];

const only = process.argv[2];

function fmt(iso?: string | null, tz = "America/New_York"): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("pt-BR", { timeZone: tz, dateStyle: "short", timeStyle: "short" }) + " ET";
  } catch {
    return String(iso);
  }
}

async function findContact(client: GHLClient, locationId: string, phone: string) {
  // lookup por telefone (o endpoint aceita E.164)
  try {
    const r = await client.get<any>(`/contacts/lookup`, { locationId, phone });
    const c = (r.contacts || [])[0];
    if (c) return c;
  } catch { /* cai pro search */ }
  try {
    const r = await client.post<any>(`/contacts/search`, {
      locationId,
      pageLimit: 5,
      filters: [{ field: "phone", operator: "eq", value: phone }],
    });
    return (r.contacts || [])[0] || null;
  } catch {
    return null;
  }
}

async function main() {
  const supabase = createAdminClient();

  for (const c of CASOS) {
    if (only && !c.phone.includes(only.replace(/\D/g, ""))) continue;
    console.log(`\n${"=".repeat(78)}`);
    console.log(`📞 ${c.phone}  —  ${c.caso}`);
    console.log("=".repeat(78));

    const client = new GHLClient(COMPANY, c.loc);
    const contact = await findContact(client, c.loc, c.phone);
    if (!contact) {
      console.log("  ❌ contato não encontrado no Spark Leads");
      continue;
    }
    console.log(`  contato: ${contact.firstName || ""} ${contact.lastName || ""} | id=${contact.id}`);
    console.log(`  tags: ${JSON.stringify(contact.tags || [])}`);

    // ---- APPOINTMENTS (todos, inclusive passados e cancelados) ----
    console.log(`\n  --- APPOINTMENTS no Spark Leads ---`);
    let appts: any[] = [];
    for (const ep of [
      { p: `/contacts/${contact.id}/appointments`, q: { locationId: c.loc } },
      { p: `/calendars/events/appointments`, q: { locationId: c.loc, contactId: contact.id } },
    ]) {
      try {
        const r = await client.get<any>(ep.p, ep.q as Record<string, string>);
        const items = r.events || r.appointments || r.data || [];
        if (items.length) { appts = items; break; }
      } catch { /* proximo */ }
    }
    if (!appts.length) console.log("    (nenhum)");
    for (const a of appts.sort((x, y) => String(x.startTime).localeCompare(String(y.startTime)))) {
      const st = (a.appointmentStatus || a.status || "?").toLowerCase();
      const mark = st === "cancelled" ? "🚫" : "📅";
      console.log(
        `    ${mark} ${fmt(a.startTime)} → ${fmt(a.endTime)} | status=${st} | id=${a.id}`
      );
      console.log(
        `        cal=${a.calendarId} | criado=${fmt(a.dateAdded || a.createdAt)} | atualizado=${fmt(a.dateUpdated || a.updatedAt)} | por=${a.createdBy?.source || a.source || "?"}`
      );
    }

    // ---- O QUE A IA FEZ (execution_log) ----
    console.log(`\n  --- execution_log da IA (últimos 7d) ---`);
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: logs } = await supabase
      .from("execution_log")
      .select("created_at, action_type, action_payload, success, error_message")
      .eq("contact_id", contact.id)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(200);
    if (!logs?.length) console.log("    (nada)");
    for (const l of logs || []) {
      const p = (l.action_payload || {}) as Record<string, any>;
      const interesting =
        /book|reschedule|cancel|slot|appointment/i.test(l.action_type) ||
        /book|appointment/i.test(JSON.stringify(p).slice(0, 300));
      if (!interesting) continue;
      const detail = [
        p.start_time ? `start=${fmt(p.start_time)}` : "",
        p.mode ? `mode=${p.mode}` : "",
        p.existing_appointment_id ? `existing=${p.existing_appointment_id}` : "",
      ].filter(Boolean).join(" ");
      console.log(
        `    ${fmt(l.created_at)} | ${l.action_type} | ok=${l.success} ${detail}${l.error_message ? ` | ERRO=${String(l.error_message).slice(0, 120)}` : ""}`
      );
    }

    // ---- ESTADO DA CONVERSA ----
    const { data: cs } = await supabase
      .from("conversation_state")
      .select("status, collected_data, message_count, ai_paused_at, ai_paused_reason, updated_at")
      .eq("contact_id", contact.id)
      .maybeSingle();
    if (cs)
      console.log(
        `\n  --- conversation_state: status=${cs.status} msgs=${cs.message_count} paused=${cs.ai_paused_at ? fmt(cs.ai_paused_at) + " (" + cs.ai_paused_reason + ")" : "não"} upd=${fmt(cs.updated_at)}`
      );
  }

  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
