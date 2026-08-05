/**
 * Check rápido: o gatilho de ativação da Alves Cury já disparou pra alguém real?
 * Olha status dos 2 agentes + reactive_trigger_fired + execution_log + fila.
 * Run: npx tsx -r tsconfig-paths/register scripts/check-alves-cury-activation.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const SALES = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
const RECRUIT = "a0339877-7096-4384-a2d8-34d9daedb339";
const LOC = "YuR0LCZomFzrfkDK2ezo";
const since = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();

async function main() {
  const sb = createAdminClient();

  const { data: agents } = await sb.from("agents").select("id,type,status,updated_at").eq("location_id", LOC).order("type");
  console.log("=== AGENTS (Alves Cury) ===");
  console.log(JSON.stringify(agents, null, 2));

  const { data: triggers } = await sb
    .from("execution_log")
    .select("agent_id,location_id,contact_id,action_payload,created_at")
    .eq("action_type", "reactive_trigger_fired")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(30);
  console.log(`\n=== reactive_trigger_fired (platform-wide, 5d) — ${triggers?.length ?? 0} ===`);
  console.log(JSON.stringify(triggers, null, 2));

  const { data: logs } = await sb
    .from("execution_log")
    .select("agent_id,action_type,ai_model_used,success,error_message,created_at")
    .in("agent_id", [SALES, RECRUIT])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(30);
  console.log(`\n=== execution_log dos 2 agentes (5d) — ${logs?.length ?? 0} ===`);
  console.log(JSON.stringify(logs, null, 2));

  const { data: mq } = await sb
    .from("message_queue")
    .select("agent_id,message_type,message_direction,status,message_body,received_at")
    .in("agent_id", [SALES, RECRUIT])
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(30);
  console.log(`\n=== message_queue dos 2 agentes (5d) — ${mq?.length ?? 0} ===`);
  console.log(JSON.stringify((mq || []).map((m) => ({ ...m, message_body: (m.message_body || "").slice(0, 80) })), null, 2));

  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
