/**
 * One-off READ-ONLY (Pedro 2026-06-18): lê a conversa do Matheus (+17325278816)
 * na sub-account efZEjK6PqtPGDHqB2vV6 pra extrair a LISTA DE GRUPOS + os 2 POSTS
 * que ele mandou pra campanha de grupo. Não escreve nada.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/read-matheus-groups-convo.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "efZEjK6PqtPGDHqB2vV6";
const PHONE = "+17325278816";

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", LOCATION_ID)
    .maybeSingle();
  if (!loc?.company_id) throw new Error("location sem company_id");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  // 1. Acha o contato por telefone.
  const search = await client.get<{ contacts?: Array<Record<string, unknown>> }>("/contacts/", {
    locationId: LOCATION_ID,
    query: PHONE,
    limit: "10",
  });
  const contacts = search.contacts || [];
  const contact =
    contacts.find((c) => String(c.phone || "").replace(/\D/g, "").endsWith("7325278816")) ||
    contacts[0];
  if (!contact) throw new Error(`contato ${PHONE} não achado na location`);
  const contactId = String(contact.id);
  console.log(`contato: ${contact.firstName || ""} ${contact.lastName || ""} | id=${contactId} | phone=${contact.phone}`);

  // 2. Conversas do contato.
  const convResp = await client.get<{
    conversations?: Array<{ id: string; lastMessageDate?: string; type?: string }>;
  }>("/conversations/search", { locationId: LOCATION_ID, contactId });
  const convs = convResp.conversations || [];
  if (convs.length === 0) throw new Error("sem conversas pro contato");
  console.log(`conversas: ${convs.length}`);

  // 3. Mensagens de cada conversa (pega bastante pra cobrir o trecho).
  type Msg = {
    id: string;
    direction?: string;
    body?: string;
    messageType?: string;
    dateAdded?: string;
    attachments?: unknown[];
    meta?: unknown;
  };
  const all: Msg[] = [];
  for (const c of convs) {
    const r = await client.get<{ messages?: { messages?: Msg[] } }>(
      `/conversations/${c.id}/messages`,
      { locationId: LOCATION_ID, limit: "100" },
    );
    const msgs = r.messages?.messages || [];
    all.push(...msgs);
  }
  // Ordena cronológico ASC.
  all.sort((a, b) => new Date(a.dateAdded || 0).getTime() - new Date(b.dateAdded || 0).getTime());

  console.log(`\n===== ${all.length} mensagens (cronológico) =====\n`);
  for (const m of all) {
    const dir = (m.direction || "?").toUpperCase().startsWith("IN") ? "← MATHEUS" : "→ NÓS";
    const when = m.dateAdded ? new Date(m.dateAdded).toISOString().replace("T", " ").slice(0, 19) : "?";
    const type = m.messageType || "";
    const att = Array.isArray(m.attachments) && m.attachments.length > 0
      ? ` [${m.attachments.length} anexo(s): ${JSON.stringify(m.attachments).slice(0, 300)}]`
      : "";
    const body = (m.body || "").trim();
    console.log(`[${when}] ${dir} ${type}${att}`);
    if (body) console.log(body);
    console.log("---");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
