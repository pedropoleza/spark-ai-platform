/**
 * Rodada 2 revisão Marcia — Frente H(1): auditar caso a caso as 6 conversas
 * auto-pausadas (auto_pause:human_message:history). READ-ONLY (só GET no GHL).
 * Uso: npx tsx -r tsconfig-paths/register scripts/probe-marcia-autopause.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";

const CASES: Array<{ contactId: string; convId: string; pausedAt: string }> = [
  { contactId: "6LytfovoSs5yhfsSYUg2", convId: "qHFgfcXJC39GWxiZ5VkC", pausedAt: "2026-07-27T18:50:12Z" },
  { contactId: "j8FXyy8OwfhbJFoJBwCd", convId: "YWtoPUoOVY9RCKic6d3p", pausedAt: "2026-07-27T08:45:10Z" },
  { contactId: "hyfuovtOCYkg9x8NKnCu", convId: "LMPex1IvSJfvOz7Y8LCr", pausedAt: "2026-07-25T13:49:33Z" },
  { contactId: "bswAVFA7tptUjZX3aYhK", convId: "TpUOyaMNap0bNHiDpV1m", pausedAt: "2026-07-24T16:15:31Z" },
  { contactId: "vDqIxHlIRSVwV0Mz1lop", convId: "VEqT7H6gUyFJAaRvMOEL", pausedAt: "2026-07-24T15:20:01Z" },
  { contactId: "Xb69OdwpQlHx75rwz2PN", convId: "98s3gay3XgVbVhL5xTUh", pausedAt: "2026-07-24T15:06:47Z" },
];

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  for (const c of CASES) {
    console.log(`\n================= contato ${c.contactId} (conv ${c.convId}) pausado ${c.pausedAt} =================`);

    // Nome do contato
    try {
      const ct = await client.get<{ contact?: { name?: string; phone?: string; tags?: string[]; assignedTo?: string } }>(
        `/contacts/${c.contactId}`,
      );
      console.log(`contato: ${ct.contact?.name} | ${ct.contact?.phone} | assignedTo=${ct.contact?.assignedTo} | tags=${JSON.stringify(ct.contact?.tags)}`);
    } catch (e) {
      console.log("contact fetch falhou:", e instanceof Error ? e.message : e);
    }

    // O que a IA registrou ter enviado
    const { data: aiSends } = await supabase
      .from("execution_log")
      .select("action_payload, created_at")
      .eq("location_id", LOCATION_ID)
      .eq("contact_id", c.contactId)
      .eq("action_type", "send_message")
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(30);
    const sentIds = new Set<string>();
    const sentTexts: string[] = [];
    for (const row of aiSends || []) {
      const p = row.action_payload as { message?: unknown; message_ids?: unknown };
      if (Array.isArray(p?.message_ids)) p.message_ids.forEach((x) => typeof x === "string" && sentIds.add(x));
      if (Array.isArray(p?.message)) p.message.forEach((m) => typeof m === "string" && sentTexts.push(m));
      else if (typeof p?.message === "string") sentTexts.push(p.message);
    }
    console.log(`aiSends: ${aiSends?.length ?? 0} rows | sentIds=${sentIds.size} | sentTexts=${sentTexts.length}`);

    // Mensagens da conversa
    try {
      const resp = await client.get<{ messages: { messages: Array<Record<string, unknown>> } }>(
        `/conversations/${c.convId}/messages`,
        { locationId: LOCATION_ID },
      );
      const msgs = (resp.messages?.messages || [])
        .slice()
        .sort((a, b) => new Date(String(a.dateAdded)).getTime() - new Date(String(b.dateAdded)).getTime());
      console.log(`total msgs na conversa: ${msgs.length}. Últimas 14:`);
      for (const m of msgs.slice(-14)) {
        const dir = m.direction === "inbound" ? "IN " : "OUT";
        const id = String(m.id || "");
        const ours = sentIds.has(id) ? "OURS(id)" : "";
        const body = String(m.body || "").replace(/\s+/g, " ").slice(0, 160);
        console.log(
          `  [${m.dateAdded}] ${dir} id=${id} userId=${m.userId ?? "-"} source=${m.source ?? "-"} type=${m.messageType} ${ours}\n      "${body}"`,
        );
      }
      const lastOut = [...msgs].reverse().find((m) => m.direction === "outbound");
      if (lastOut) {
        const id = String(lastOut.id || "");
        console.log(
          `  >> ÚLTIMO OUTBOUND HOJE: id=${id} ours_by_id=${sentIds.has(id)} userId=${lastOut.userId ?? "-"} source=${lastOut.source ?? "-"} date=${lastOut.dateAdded}`,
        );
      }
    } catch (e) {
      console.log("messages fetch falhou:", e instanceof Error ? e.message : e);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
