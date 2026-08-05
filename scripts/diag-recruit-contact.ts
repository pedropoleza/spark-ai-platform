/**
 * Diagnóstico: por que o agente de recrutamento não respondeu o contato
 * 8fHxTWMaL8bkpbsB3oFg (Alves Cury). Rastreia agente/targeting/fila/skip/webhook.
 * Run: npx tsx -r tsconfig-paths/register scripts/diag-recruit-contact.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const CONTACT = "8fHxTWMaL8bkpbsB3oFg";
const RECRUIT = "a0339877-7096-4384-a2d8-34d9daedb339";
const SALES = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
const LOC = "YuR0LCZomFzrfkDK2ezo";

function show(title: string, data: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const sb = createAdminClient();

  const { data: agents } = await sb.from("agents").select("id,type,status").eq("location_id", LOC).order("type");
  show("AGENTS (status)", agents);

  const { data: cfg } = await sb
    .from("agent_configs")
    .select("agent_id,enabled_channels,targeting_rules")
    .in("agent_id", [SALES, RECRUIT]);
  show("CONFIG (channels + targeting)", cfg);

  const { data: mq } = await sb
    .from("message_queue")
    .select("id,agent_id,message_type,channel,message_direction,status,message_body,received_at,process_after")
    .eq("contact_id", CONTACT)
    .order("received_at", { ascending: false })
    .limit(20);
  show(`message_queue do contato — ${mq?.length ?? 0}`, (mq || []).map((m) => ({ ...m, message_body: (m.message_body || "").slice(0, 80) })));

  const { data: elog } = await sb
    .from("execution_log")
    .select("agent_id,action_type,success,error_message,created_at")
    .eq("contact_id", CONTACT)
    .order("created_at", { ascending: false })
    .limit(20);
  show(`execution_log do contato — ${elog?.length ?? 0}`, elog);

  const { data: conv } = await sb
    .from("conversation_state")
    .select("agent_id,status,message_count,ai_paused_at,ai_paused_reason,last_message_at")
    .eq("contact_id", CONTACT);
  show("conversation_state do contato", conv);

  const { data: wh } = await sb
    .from("inbound_webhook_samples")
    .select("message_type,detected_channel,is_real_message,received_at,raw")
    .eq("contact_id", CONTACT)
    .order("received_at", { ascending: false })
    .limit(8);
  show(`inbound_webhook_samples do contato — ${wh?.length ?? 0}`, (wh || []).map((w) => ({ ...w, raw: JSON.stringify(w.raw).slice(0, 700) })));

  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
