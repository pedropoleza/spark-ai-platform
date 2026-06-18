/**
 * Diagnóstico do agente Marina (recrutamento, IG) — Pedro 2026-06-18.
 *
 * Puxa o thread COMPLETO do GHL (humano + IA + automação) de cada contato
 * recente do agente, classifica cada mensagem, e cruza com o que a gente
 * registrou (send_message, follow-ups agendados/enviados, should_respond_skip,
 * ai_paused, targeting_skip). Objetivo: achar (a) follow-up sem contexto
 * (ex.: lead disse "vou viajar, depois falo" e a IA perguntou se já voltou),
 * (b) IA atravessando humano, (c) lead respondeu e IA não respondeu.
 *
 * Saída: _planning/marina-conversas/dump.json (1 objeto por contato) + resumo
 * no stdout + threads de Gisele/Vandinha inline.
 *
 *   npx tsx -r tsconfig-paths/register scripts/diag-marina-conversations.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { writeFileSync, mkdirSync } from "fs";
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { AUTOMATION_SOURCES } from "../src/lib/ghl/message-sources";
import { isAiEcho, extractAiSentTexts } from "../src/lib/queue/human-takeover";

const LOCATION = "A62s5EQj1hldOuvBEowv";
const AGENT = "3976b4b6-0345-4f25-b964-138bb7960058";

type Msg = { direction?: string; body?: string; dateAdded?: string; source?: string; userId?: string; messageType?: string };

function classifyWho(m: Msg, aiTexts: string[]): string {
  const dir = m.direction === "inbound" ? "inbound" : "outbound";
  if (dir === "inbound") return "LEAD";
  const src = String(m.source || "").toLowerCase();
  if (src === "api") return "IA";
  if (AUTOMATION_SOURCES.has(src)) return "AUTOMACAO";
  const body = String(m.body || "").trim();
  if (body && isAiEcho(body, aiTexts)) return "IA"; // eco do envio da IA (source app + userId admin)
  if (m.userId) return "HUMANO"; // user do GHL mandou manual
  if (aiTexts.length === 0) return "AUTOMACAO?"; // IA nunca falou → provável anúncio/automação
  return "HUMANO?";
}

async function fetchContact(client: GHLClient, supabase: ReturnType<typeof createAdminClient>, contactId: string) {
  const [contactRes, convRes, sendsRes, fupsRes, stateRes, logRes] = await Promise.all([
    client.get<{ contact?: { firstName?: string; lastName?: string; name?: string; phone?: string; tags?: string[] } }>(`/contacts/${contactId}`).catch(() => null),
    client.get<{ conversations?: Array<{ id: string }> }>(`/conversations/search?locationId=${LOCATION}&contactId=${contactId}&limit=5`).catch(() => null),
    supabase.from("execution_log").select("action_payload").eq("location_id", LOCATION).eq("contact_id", contactId).eq("action_type", "send_message").eq("success", true).order("created_at", { ascending: false }).limit(30),
    supabase.from("scheduled_followups").select("id,status,created_at,scheduled_at,message_body,sequence_step").eq("agent_id", AGENT).eq("contact_id", contactId).order("created_at", { ascending: true }),
    supabase.from("conversation_state").select("status,message_count,last_ai_response_at,last_message_at,ai_paused_at,ai_paused_reason,ai_resumed_at,collected_data,updated_at,created_at").eq("agent_id", AGENT).eq("contact_id", contactId).maybeSingle(),
    supabase.from("execution_log").select("action_type,action_payload,created_at").eq("agent_id", AGENT).eq("contact_id", contactId).order("created_at", { ascending: true }).limit(80),
  ]);

  const contact = contactRes?.contact || {};
  const name = (contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`).trim() || "(sem nome)";
  const aiTexts = extractAiSentTexts((sendsRes.data as Array<{ action_payload: unknown }>) || []);

  const mainConv = convRes?.conversations?.[0];
  let msgs: Msg[] = [];
  if (mainConv) {
    const mr = await client.get<{ messages?: { messages?: Msg[] } }>(`/conversations/${mainConv.id}/messages?limit=50`).catch(() => null);
    msgs = mr?.messages?.messages || [];
  }
  // GHL retorna desc → ordena asc por dateAdded
  const timeline = msgs
    .map((m) => ({
      ts: String(m.dateAdded || ""),
      who: classifyWho(m, aiTexts),
      dir: m.direction === "inbound" ? "in" : "out",
      src: m.source || null,
      userId: m.userId || null,
      type: m.messageType || null,
      body: String(m.body || "").slice(0, 500),
    }))
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  return {
    contactId,
    name,
    phone: contact.phone || null,
    tags: contact.tags || [],
    state: stateRes.data || null,
    followups: (fupsRes.data || []).map((f) => ({ ...f, message_body: String((f as { message_body?: string }).message_body || "").slice(0, 300) })),
    actions: (logRes.data || []).map((a) => ({ t: a.action_type, at: a.created_at, p: JSON.stringify(a.action_payload).slice(0, 300) })),
    thread: timeline,
  };
}

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION).single();
  if (!loc?.company_id) throw new Error("companyId não encontrado pra location");
  const client = new GHLClient(loc.company_id, LOCATION);

  // Contatos recentes do agente (mais ativos primeiro)
  const { data: states } = await supabase
    .from("conversation_state")
    .select("contact_id, updated_at, message_count")
    .eq("agent_id", AGENT)
    .order("updated_at", { ascending: false })
    .limit(45);
  const contactIds = Array.from(new Set((states || []).map((s) => s.contact_id)));

  console.log(`\nPuxando ${contactIds.length} contatos do GHL (location ${LOCATION})...\n`);

  const results: Awaited<ReturnType<typeof fetchContact>>[] = [];
  // Sequencial em lotes pequenos pra não estourar rate limit do GHL.
  for (let i = 0; i < contactIds.length; i += 4) {
    const batch = contactIds.slice(i, i + 4);
    const got = await Promise.all(batch.map((id) => fetchContact(client, supabase, id).catch((e) => ({ contactId: id, error: String(e) } as never))));
    results.push(...got);
    process.stdout.write(`  ${Math.min(i + 4, contactIds.length)}/${contactIds.length}\r`);
  }

  mkdirSync(resolve(__dirname, "..", "_planning", "marina-conversas"), { recursive: true });
  const outPath = resolve(__dirname, "..", "_planning", "marina-conversas", "dump.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n\nDump salvo: ${outPath}\n`);

  // Resumo: por contato, sinais de problema
  console.log("=== RESUMO (nome | msgs | followups | IA respondeu? | humano no thread? | pausa) ===");
  for (const r of results) {
    if ((r as { error?: string }).error) { console.log(`  ⚠️ ${r.contactId}: ${(r as { error?: string }).error}`); continue; }
    const t = r.thread || [];
    const hasHuman = t.some((m) => m.who === "HUMANO" || m.who === "HUMANO?");
    const aiMsgs = t.filter((m) => m.who === "IA").length;
    const leadMsgs = t.filter((m) => m.who === "LEAD").length;
    const fupsSent = (r.followups || []).filter((f) => f.status === "sent").length;
    const lastWho = t.length ? t[t.length - 1].who : "-";
    const st = r.state as { ai_paused_at?: string | null; message_count?: number } | null;
    console.log(`  • ${r.name.padEnd(24)} | lead:${leadMsgs} ia:${aiMsgs} | fup_sent:${fupsSent} | last:${lastWho} | ${hasHuman ? "TEM_HUMANO" : ""} ${st?.ai_paused_at ? "PAUSADO" : ""}`);
  }

  // Threads-alvo inline
  for (const r of results) {
    const n = r.name?.toLowerCase() || "";
    if (n.includes("gis") || n.includes("chehab") || n.includes("vand")) {
      console.log(`\n\n===== THREAD: ${r.name} (${r.contactId}) =====`);
      console.log(`state: ${JSON.stringify(r.state)}`);
      for (const m of r.thread || []) console.log(`  [${m.ts}] ${m.who.padEnd(10)} ${m.dir} (src=${m.src || "-"}): ${m.body.replace(/\n/g, " ⏎ ")}`);
      console.log(`  --- follow-ups:`);
      for (const f of r.followups || []) console.log(`    (${f.status}) sched=${f.scheduled_at} step=${(f as {sequence_step?:number}).sequence_step}: ${f.message_body.replace(/\n/g, " ⏎ ")}`);
    }
  }
  console.log("\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
