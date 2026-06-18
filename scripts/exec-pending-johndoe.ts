/**
 * Executa as pendências do John Doe (Pedro) das transcrições 12-13/jun, usando
 * os HANDLERS REAIS do SparkBot (executeTool) — dedup, phone BR-aware, schema
 * de agendamento corretos. Idempotente: search antes de criar.
 *
 *   npx tsx -r tsconfig-paths/register scripts/exec-pending-johndoe.ts
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

// Contatos a garantir (criar com 1º nome se não existir). [first, last, phone]
const CONTACTS: [string, string | null, string][] = [
  ["Mariana", "Oliveira", "+13215370707"],
  ["Márcia", "Daidone", "+18136669373"],
  ["Diana", null, "+12037212187"],
  ["Helene", "Borges", "+17542017077"],
  ["Alessandra", "Bandeira", "+13219008291"],
  ["Thaís", "Gerdt", "+15612297637"],
  ["Catlin", null, "+18572372439"],
  ["Pablo", null, "+15083716240"],
  ["Davi", null, "+15614307549"],
  ["Maria Eduarda", null, "+14847217198"],
  ["Renato", null, "+12673678420"],
];

// Mensagens pro LEAD que NÃO dependem de link [phone, sendAtISO, message]
const MESSAGES: [string, string, string][] = [
  ["+14079549205", "2026-06-15T09:00:00-04:00", "Oi Raquel! Aqui é o Pedro do Spark Leads. Queria te apresentar o Spark — me responde aqui que a gente acha um horário essa semana. 🙌"],
  ["+14058897606", "2026-07-13T10:00:00-04:00", "Oi Marcelo! Tudo certo? Passando pra saber se você já tá pronto pra começar a usar o Spark. Bora marcar uma conversa?"],
  ["+15618161460", "2026-06-15T09:00:00-04:00", "Oi Erika! Aqui é o Pedro do Spark Leads. Fazendo aquele follow-up — quando você tem um tempo pra gente ver o Spark juntos?"],
];

// Lembretes pro PEDRO (vão pro rep, não pro lead) [remindAtISO, message]
const REMINDERS: [string, string][] = [
  ["2026-07-13T09:00:00-04:00", "Ligar pra Catlin (+1 857-237-2439) e Pablo (+1 508-371-6240) — casal que produz junto. Ver se já precisam de um CRM (Spark)."],
  ["2026-08-13T09:00:00-04:00", "Chamar Maria Eduarda (+1 484-721-7198) e Renato (+1 267-367-8420) — ver se já faz sentido implementar o Spark na operação deles."],
];

async function main() {
  const supabase = createAdminClient();
  const { data: rep } = await supabase.from("rep_identities").select("*").eq("id", REP_ID).single();
  if (!rep) throw new Error("rep não encontrado");
  const ctx: ToolContext = {
    rep: rep as ToolContext["rep"],
    locationId: LOCATION,
    companyId: COMPANY,
    ghlClient: new GHLClient(COMPANY, LOCATION),
    testSessionId: null,
    confirmationMode: "high_only",
  };

  console.log("===== 1) CONTATOS =====");
  for (const [first, last, phone] of CONTACTS) {
    const found = await executeTool("search_contacts", { query: phone.replace("+", "") }, ctx);
    const hit = (found.data as { contacts?: Array<{ id: string }> })?.contacts?.[0];
    if (hit?.id) { console.log(`  ${first} ${last || ""} (${phone}): já existe (${hit.id})`); continue; }
    const r = await executeTool("create_contact", { first_name: first, ...(last ? { last_name: last } : {}), phone, source: "Convenção 13/jun" }, ctx);
    console.log(`  ${first} ${last || ""} (${phone}): ${r.status === "ok" ? "✅ criado" : "❌ " + r.message}`);
  }

  console.log("\n===== 2) MENSAGENS PRO LEAD (sem link) =====");
  for (const [phone, sendAt, message] of MESSAGES) {
    const found = await executeTool("search_contacts", { query: phone.replace("+", "") }, ctx);
    const hit = (found.data as { contacts?: Array<{ id: string }> })?.contacts?.[0];
    if (!hit?.id) { console.log(`  ${phone}: ❌ contato não achado — pulado`); continue; }
    const r = await executeTool("schedule_message_to_contact", { contact_id: hit.id, message, send_at: sendAt, channel: "SMS", confirmed_by_rep: true }, ctx);
    console.log(`  ${phone} @ ${sendAt}: ${r.status === "ok" ? "✅ agendada" : "❌ " + r.message}`);
  }

  console.log("\n===== 3) LEMBRETES PRO PEDRO =====");
  for (const [remindAt, message] of REMINDERS) {
    const r = await executeTool("schedule_reminder", { message, remind_at: remindAt, confirmed_by_rep: true }, ctx);
    console.log(`  @ ${remindAt}: ${r.status === "ok" ? "✅ agendado" : "❌ " + r.message}`);
  }

  console.log("\nDONE.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
