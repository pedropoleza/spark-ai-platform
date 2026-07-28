/**
 * Probe efêmero (rodada 2 revisão Marcia, 2026-07-28) — READ-ONLY.
 * Caso da policy: +1 203 706-2691 ("a mulher já recebeu a policy e a IA
 * continua fazendo loucura"). Puxa do GHL:
 *  1. contato por telefone (query + fallback)
 *  2. oportunidades (status/stage/pipeline) + nomes de pipeline/stage
 *  3. conversa recente (~40 msgs, direction/type/dateAdded/body)
 * Só GETs. Nada de escrita.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const PHONE = "+12037062691";

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", LOCATION_ID)
    .maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  // 1. contato por telefone
  const search = await client.get<{ contacts?: Array<Record<string, unknown>> }>(
    "/contacts/",
    { locationId: LOCATION_ID, query: PHONE, limit: 10 },
  );
  let contacts = search.contacts || [];
  if (contacts.length === 0) {
    // fallback: sufixo sem +1
    const s2 = await client.get<{ contacts?: Array<Record<string, unknown>> }>(
      "/contacts/",
      { locationId: LOCATION_ID, query: "2037062691", limit: 10 },
    );
    contacts = s2.contacts || [];
  }
  console.log(`=== CONTATOS (${contacts.length}) ===`);
  for (const c of contacts) {
    console.log(JSON.stringify({
      id: c.id, name: c.contactName || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      phone: c.phone, email: c.email, tags: c.tags, dateAdded: c.dateAdded,
      assignedTo: c.assignedTo, source: c.source,
    }, null, 2));
  }
  const contact = contacts[0];
  if (!contact?.id) { console.log("CONTATO NÃO ENCONTRADO"); process.exit(0); }
  const contactId = String(contact.id);

  // 2. oportunidades
  const opps = await client.get<{ opportunities?: Array<Record<string, unknown>> }>(
    "/opportunities/search",
    { location_id: LOCATION_ID, contact_id: contactId, limit: 20 },
  );
  const oppList = opps.opportunities || [];

  // nomes de pipeline/stage
  const pipes = await client.get<{ pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> }>(
    "/opportunities/pipelines",
    { locationId: LOCATION_ID },
  );
  const stageName = (pid?: unknown, sid?: unknown) => {
    const p = (pipes.pipelines || []).find((x) => x.id === pid);
    const s = p?.stages?.find((x) => x.id === sid);
    return { pipeline: p?.name || String(pid || "?"), stage: s?.name || String(sid || "?") };
  };
  console.log(`\n=== OPORTUNIDADES (${oppList.length}) ===`);
  for (const o of oppList) {
    const names = stageName(o.pipelineId, o.pipelineStageId);
    console.log(JSON.stringify({
      id: o.id, name: o.name, status: o.status,
      pipeline: names.pipeline, stage: names.stage,
      monetaryValue: o.monetaryValue,
      createdAt: o.createdAt, updatedAt: o.updatedAt,
      lastStatusChangeAt: (o as Record<string, unknown>).lastStatusChangeAt,
      lastStageChangeAt: (o as Record<string, unknown>).lastStageChangeAt,
    }, null, 2));
  }

  // 3. conversa recente
  const convSearch = await client.get<{ conversations?: Array<{ id: string; lastMessageDate?: string; type?: string }> }>(
    "/conversations/search",
    { locationId: LOCATION_ID, contactId },
  );
  const convs = convSearch.conversations || [];
  console.log(`\n=== CONVERSAS (${convs.length}) ===`);
  for (const cv of convs) console.log(JSON.stringify(cv));

  for (const cv of convs) {
    const msgs = await client.get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(
      `/conversations/${cv.id}/messages`,
      { locationId: LOCATION_ID, limit: 60 },
    );
    const list = (msgs.messages?.messages || []).sort(
      (a, b) => new Date(String(a.dateAdded || 0)).getTime() - new Date(String(b.dateAdded || 0)).getTime(),
    );
    console.log(`\n=== MENSAGENS conv ${cv.id} (${list.length}, ordem cronológica) ===`);
    for (const m of list) {
      const dir = String(m.direction || "?").padEnd(8);
      const src = String((m as Record<string, unknown>).source || "");
      const body = String(m.body || "(vazio)").replace(/\n/g, " ⏎ ").slice(0, 220);
      console.log(`[${m.dateAdded}] [${dir}] ${m.messageType || "?"}${src ? ` src=${src}` : ""} | ${body}`);
    }
  }
  console.log(`\ncontactId pra cruzar com prod: ${contactId}`);
  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
