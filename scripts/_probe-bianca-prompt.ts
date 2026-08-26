// READ-ONLY — inspeciona a disciplina de horários no prompt do agente A.
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const AGENT = process.argv[2] || "17860a86-ace9-4299-9328-2452151348a0";

async function main() {
  const sb = createAdminClient();
  const { data } = await sb.from("agent_configs").select("custom_instructions").eq("agent_id", AGENT).single();
  const ci = data?.custom_instructions || "";
  console.log("tamanho:", ci.length);
  const termos = ["horários disponíveis", "lista de horários", "NUNCA invente", "não invente", "fora da lista", "copie", "exatamente como aparece"];
  for (const t of termos) console.log(`  "${t}": ${(ci.match(new RegExp(t, "gi")) || []).length}`);
  const idx = ci.toUpperCase().indexOf("AGENDA");
  console.log("\n--- trecho perto de AGENDA ---");
  console.log(ci.slice(Math.max(0, idx - 300), idx + 1100));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e?.message); process.exit(1); });
