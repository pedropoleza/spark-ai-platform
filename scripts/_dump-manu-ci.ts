// READ-ONLY: baixa a config da Manu pra backup + trabalho de compactação
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { writeFileSync } from "fs";

const MANU = "3976b4b6-0345-4f25-b964-138bb7960058";

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();
  const { data } = await sb
    .from("agent_configs")
    .select("custom_instructions, conversation_examples, knowledge_base_instructions, handoff_policy, notifications")
    .eq("agent_id", MANU)
    .single();
  if (!data) throw new Error("config não encontrada");
  writeFileSync("/tmp/manu-backup.json", JSON.stringify(data, null, 2));
  writeFileSync("/tmp/manu-ci.txt", data.custom_instructions || "");
  console.log("ci:", (data.custom_instructions || "").length, "chars");
  console.log("backup: /tmp/manu-backup.json");
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
