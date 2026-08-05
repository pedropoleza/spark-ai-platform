/** READ-ONLY (Pedro 2026-06-19): dump COMPLETO da conversa do SparkBot com a Jussara
 * (+16892033343, contato hub kTVVSlYqF8JBbFuZFRvj) com bodies inteiros, pra estudo
 * do fluxo grande que ela pediu. Escreve em _planning/jussara-sparkbot/conversa-raw.txt. */
import { config } from "dotenv";
import { resolve } from "path";
import { writeFileSync } from "fs";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const HUB = "RBFxlEQZobaDjlF2i5px";
const CONTACT = "kTVVSlYqF8JBbFuZFRvj";

async function main() {
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", HUB).maybeSingle();
  const client = new GHLClient(loc!.company_id, HUB);
  const cs = await client.get<{ conversations?: Array<{ id: string }> }>("/conversations/search", { locationId: HUB, contactId: CONTACT });
  const convs = cs.conversations || [];
  type Msg = { id: string; direction?: string; body?: string; messageType?: string; dateAdded?: string; attachments?: unknown[] };
  const all: Msg[] = [];
  for (const c of convs) {
    let page = 0;
    // pagina até 200 msgs
    const r = await client.get<{ messages?: { messages?: Msg[] } }>(`/conversations/${c.id}/messages`, { locationId: HUB, limit: "200" });
    all.push(...(r.messages?.messages || []));
    void page;
  }
  all.sort((a, b) => new Date(a.dateAdded || 0).getTime() - new Date(b.dateAdded || 0).getTime());
  const lines: string[] = [`Conversa SparkBot × Jussara (+16892033343) — ${all.length} mensagens`, "=".repeat(70), ""];
  for (const m of all) {
    const dir = String(m.direction || "").toUpperCase().startsWith("IN") ? "← JUSSARA" : "→ BOT/NÓS";
    const when = String(m.dateAdded || "").slice(0, 19).replace("T", " ");
    const att = Array.isArray(m.attachments) && m.attachments.length ? ` [anexos: ${JSON.stringify(m.attachments)}]` : "";
    lines.push(`[${when}] ${dir} (${m.messageType})${att}`);
    if ((m.body || "").trim()) lines.push((m.body || "").trim());
    lines.push("-".repeat(70));
  }
  const out = resolve(__dirname, "..", "_planning", "jussara-sparkbot", "conversa-raw.txt");
  writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`escrito: ${out} (${all.length} msgs, ${lines.join("\n").length} chars)`);
  const inbound = all.filter((m) => String(m.direction || "").toUpperCase().startsWith("IN"));
  console.log(`inbound (Jussara): ${inbound.length} | outbound: ${all.length - inbound.length}`);
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
