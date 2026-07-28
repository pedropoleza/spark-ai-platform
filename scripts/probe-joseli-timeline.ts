/**
 * PROBE READ-ONLY: timeline exata da conversa do print (Alves Cury / Joseli Belo)
 * pra confirmar QUAL outbound o `isHumanOutboundMessage` está marcando como
 * humano (hipótese: a LIGAÇÃO, body vazio + userId do rep).
 *
 * Uso: npx tsx scripts/probe-joseli-timeline.ts [CONTACT_ID]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { isHumanOutboundMessage } from "@/lib/queue/lead-history";
import { extractAiSentTexts, extractAiSentIds } from "@/lib/queue/human-takeover";

const LOCATION = "YuR0LCZomFzrfkDK2ezo";

async function main() {
  const contactId = process.argv[2] || "sL5oCpvfiqKh4SD7sLxL";
  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations").select("company_id").eq("location_id", LOCATION).maybeSingle();
  const client = new GHLClient(loc!.company_id as string, LOCATION);

  const { data: cs } = await supabase
    .from("conversation_state").select("conversation_id, status, ai_paused_at, message_count")
    .eq("location_id", LOCATION).eq("contact_id", contactId).maybeSingle();
  console.log(`conversation_state: ${JSON.stringify(cs)}`);

  const { data: sends } = await supabase
    .from("execution_log").select("action_payload")
    .eq("location_id", LOCATION).eq("contact_id", contactId)
    .eq("action_type", "send_message").eq("success", true)
    .order("created_at", { ascending: false }).limit(30);
  const aiTexts = extractAiSentTexts(sends);
  const aiIds = extractAiSentIds(sends);
  console.log(`IA registrou: ${aiTexts.length} textos, ${aiIds.length} ids\n`);

  const res = await client.get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(
    `/conversations/${cs!.conversation_id}/messages`,
    { locationId: LOCATION },
  );
  const msgs = (res?.messages?.messages || []).slice()
    .sort((a, b) => new Date(String(a.dateAdded)).getTime() - new Date(String(b.dateAdded)).getTime());

  console.log("=== TIMELINE (mais antigo → mais novo) ===");
  for (const m of msgs) {
    const dir = String(m.direction);
    const body = String(m.body || "");
    const mt = String(m.messageType || m.type || "?");
    const uid = m.userId ? String(m.userId) : null;
    const src = m.source ? String(m.source) : null;
    const isOurs = aiIds.includes(String(m.id));
    let flag = "";
    if (dir === "outbound") {
      const human = isHumanOutboundMessage(
        { direction: dir, source: src, body, userId: uid },
        aiTexts,
      );
      flag = human ? "  ⛔ CONTADO COMO HUMANO" : "  ok (não-humano)";
      if (human && isOurs) flag += " ← MAS O ID É NOSSO!";
    }
    console.log(
      `${String(m.dateAdded).slice(11, 19)} ${dir.padEnd(8)} ${mt.padEnd(18)} ` +
      `uid=${uid ? uid.slice(0, 8) : "-"} src=${src || "-"} ours=${isOurs} ` +
      `body=${JSON.stringify(body.slice(0, 45))}${flag}`,
    );
  }

  const lastHuman = msgs.slice().reverse().find((m) =>
    isHumanOutboundMessage(
      { direction: String(m.direction), source: m.source ? String(m.source) : null, body: String(m.body || ""), userId: m.userId ? String(m.userId) : null },
      aiTexts,
    ),
  );
  console.log(`\n>>> last_human_outbound_at = ${lastHuman ? lastHuman.dateAdded : "null"}`);
  if (lastHuman) {
    console.log(`>>> tipo: ${lastHuman.messageType || lastHuman.type} · body=${JSON.stringify(String(lastHuman.body || "").slice(0, 50))} · id nosso? ${aiIds.includes(String(lastHuman.id))}`);
  }
  process.exit(0);
}

main();
