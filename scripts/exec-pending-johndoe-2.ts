/**
 * Lote 2 das pendências do John Doe: agendamentos (com override onde o Pedro
 * autorizou) + lembretes. Usa handlers reais (executeTool). Grupo: pega o
 * meeting location do appt já marcado (Nathalia) e reusa nos outros 4.
 *   npx tsx -r tsconfig-paths/register scripts/exec-pending-johndoe-2.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { executeTool } from "../src/lib/account-assistant/tools";
import type { ToolContext } from "../src/lib/account-assistant/tools/types";

const REP_ID = "1eeb02cc-1a48-4b56-b177-52dcbca07ac2";
const LOCATION = "efZEjK6PqtPGDHqB2vV6";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

async function contactIdByPhone(ctx: ToolContext, phone: string): Promise<string | null> {
  const r = await executeTool("search_contacts", { query: phone.replace("+", "") }, ctx);
  return (r.data as { contacts?: Array<{ id: string }> })?.contacts?.[0]?.id ?? null;
}

async function main() {
  const supabase = createAdminClient();
  const { data: rep } = await supabase.from("rep_identities").select("*").eq("id", REP_ID).single();
  if (!rep) throw new Error("rep não encontrado");
  const ghlClient = new GHLClient(COMPANY, LOCATION);
  const ctx: ToolContext = { rep: rep as ToolContext["rep"], locationId: LOCATION, companyId: COMPANY, ghlClient, testSessionId: null, confirmationMode: "high_only" };

  // Demo calendar id + meeting location da Nathalia (o "1" já marcado do grupo)
  const cal = await ghlClient.get<{ calendars?: Array<{ id: string; name?: string }> }>("/calendars/", { locationId: LOCATION });
  const demo = (cal.calendars || []).find((c) => /demo/i.test(c.name || ""));
  if (!demo) throw new Error("calendário Demo não achado");
  let groupLocation = "";
  try {
    const start = new Date("2026-06-19T00:00:00Z").getTime();
    const end = new Date("2026-06-20T00:00:00Z").getTime();
    const ev = await ghlClient.get<{ events?: Array<{ title?: string; address?: string }> }>("/calendars/events", { locationId: LOCATION, calendarId: demo.id, startTime: String(start), endTime: String(end) });
    groupLocation = (ev.events || []).find((e) => /grupo|nathalia/i.test(e.title || ""))?.address || "";
  } catch { /* segue sem link explícito */ }
  console.log(`Demo cal=${demo.id} | meeting location do grupo (Nathalia): "${groupLocation || "(default do calendário)"}"`);

  // [phone, startISO, endISO, title, override]
  const APPTS: [string, string, string, string, boolean][] = [
    ["+15614307549", "2026-06-17T15:00:00-04:00", "2026-06-17T15:30:00-04:00", "Demo - Davi", false],
    ["+15612297637", "2026-06-15T13:00:00-04:00", "2026-06-15T13:30:00-04:00", "Demo - Thaís Gerdt", true],
    ["+18573268561", "2026-06-17T17:00:00-04:00", "2026-06-17T17:30:00-04:00", "Demo - André e Fernanda", true],
    ["+13215370707", "2026-06-17T15:00:00-04:00", "2026-06-17T15:30:00-04:00", "Demo - Mariana e Márcia", true],
    ["+15614517893", "2026-06-19T10:00:00-04:00", "2026-06-19T10:30:00-04:00", "Demo - Natalia Oliveira", true],
    ["+15618161460", "2026-06-15T13:00:00-04:00", "2026-06-15T13:30:00-04:00", "Demo - Erika Barbosa", true],
  ];
  const GROUP: [string, string][] = [
    ["+16897103359", "Eric"], ["+16898008602", "Roger"], ["+15619830388", "Natália"], ["+17549712912", "Wesley"],
  ];

  console.log("\n===== AGENDAMENTOS =====");
  for (const [phone, startT, endT, title, override] of APPTS) {
    const cid = await contactIdByPhone(ctx, phone);
    if (!cid) { console.log(`  ${title}: ❌ contato (${phone}) não achado`); continue; }
    const r = await executeTool("create_appointment", {
      calendar_id: demo.id, contact_id: cid, start_time: startT, end_time: endT, title,
      confirmed_by_rep: true, ...(override ? { ignore_free_slot_validation: true } : {}),
    }, ctx);
    console.log(`  ${title} @ ${startT}${override ? " (override)" : ""}: ${r.status === "ok" ? "✅" : "❌ " + r.message}`);
  }

  console.log("\n===== GRUPO (sex 19/jun 14h, mesmo location) =====");
  for (const [phone, name] of GROUP) {
    const cid = await contactIdByPhone(ctx, phone);
    if (!cid) { console.log(`  ${name}: ❌ contato não achado`); continue; }
    const r = await executeTool("create_appointment", {
      calendar_id: demo.id, contact_id: cid,
      start_time: "2026-06-19T14:00:00-04:00", end_time: "2026-06-19T14:30:00-04:00",
      title: "Reunião em Grupo - Demo Spark Leads", confirmed_by_rep: true, ignore_free_slot_validation: true,
      ...(groupLocation ? { meeting_location_type: "custom", meeting_location: groupLocation } : {}),
    }, ctx);
    console.log(`  ${name}: ${r.status === "ok" ? "✅" : "❌ " + r.message}`);
  }

  console.log("\n===== LEMBRETES PRO PEDRO =====");
  const REMINDERS: [string, string][] = [
    ["2026-06-15T09:00:00-04:00", "Ligar pra Helene Borges (+1 754-201-7077) pra marcar a demo do Spark — ela pode a partir de quarta."],
    ["2026-06-15T09:00:00-04:00", "Ligar/mandar a agenda pra Diana (+1 203-721-2187) escolher o horário da demo do Spark."],
    ["2026-06-15T09:00:00-04:00", "Ligar pro Aguinaldo Goncalves (+1 774-433-3147) pra ele voltar a usar o Spark."],
    ["2026-06-22T09:00:00-04:00", "Ligar pra Alessandra Bandeira (+1 321-900-8291) pra marcar a demo do Spark (semana do dia 22)."],
    ["2026-06-22T09:00:00-04:00", "Ligar pra Graciele dos Santos (+1 774-270-5092) pra marcar a demonstração do Spark."],
  ];
  for (const [remindAt, message] of REMINDERS) {
    const r = await executeTool("schedule_reminder", { message, remind_at: remindAt, confirmed_by_rep: true }, ctx);
    console.log(`  @ ${remindAt}: ${r.status === "ok" ? "✅ " + message.slice(0, 45) : "❌ " + r.message}`);
  }
  console.log("\nDONE.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
