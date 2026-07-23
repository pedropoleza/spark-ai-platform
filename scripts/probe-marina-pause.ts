/**
 * Probe (2026-07-23): o que EXATAMENTE foi o "último outbound" que fez o F52
 * auto-pausar a conversa da Marina como 'human_message:history'? Lê ao vivo do
 * GHL as últimas mensagens de 2 contatos pausados + os textos que a IA registrou
 * ter enviado (execution_log), pra ver por que o anti-eco não casou.
 *
 * READ-ONLY. Rodar: npx tsx scripts/probe-marina-pause.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";
import { getConversationMessages } from "@/lib/ghl/operations";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractAiSentTexts } from "@/lib/queue/human-takeover";

const LOCATION = "A62s5EQj1hldOuvBEowv";
const CONTACTS = ["5aztWfUoUkuwM7HU5duZ", "qSD3NsGbd9HDuNyf7ezZ"];

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION).maybeSingle();
  const client = new GHLClient(loc!.company_id as string, LOCATION);

  for (const contactId of CONTACTS) {
    console.log(`\n══════ contato ${contactId} ══════`);
    // conversation_id via conversation_state
    const { data: cs } = await supabase.from("conversation_state")
      .select("conversation_id, ai_paused_at").eq("location_id", LOCATION).eq("contact_id", contactId).maybeSingle();
    console.log(`pausada em: ${cs?.ai_paused_at} · conv=${cs?.conversation_id}`);
    if (!cs?.conversation_id) { console.log("sem conversation_id"); continue; }

    const res = await getConversationMessages(client, cs.conversation_id, LOCATION, 12).catch((e) => {
      console.log("GHL falhou:", e instanceof Error ? e.message.slice(0, 80) : e); return null;
    });
    const msgs = (res?.messages?.messages || []).slice().reverse(); // asc
    console.log("Últimas msgs (GHL):");
    for (const m of msgs.slice(-8)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const src = (m as any).source ?? "?";
      console.log(`  [${m.direction}] ${m.dateAdded} src=${src} userId=${m.userId || "-"} type=${m.messageType || "?"} :: ${JSON.stringify(m.body || "").slice(0, 70)}`);
    }
    const lastOut = [...msgs].reverse().find((m) => m.direction === "outbound");
    console.log(`\n  ÚLTIMO OUTBOUND: ${JSON.stringify(lastOut?.body || "").slice(0, 90)} (userId=${lastOut?.userId || "-"})`);

    const { data: aiSends } = await supabase.from("execution_log")
      .select("action_payload, created_at").eq("location_id", LOCATION).eq("contact_id", contactId)
      .eq("action_type", "send_message").eq("success", true).order("created_at", { ascending: false }).limit(10);
    const aiTexts = extractAiSentTexts(aiSends);
    console.log(`  IA registrou ${aiTexts.length} envios. Amostra: ${aiTexts.slice(0, 3).map((t) => JSON.stringify(t.slice(0, 50))).join(" | ")}`);
  }
}

main().then(() => process.exit(0));
