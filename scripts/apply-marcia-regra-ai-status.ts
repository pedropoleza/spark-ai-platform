/**
 * Conta da Márcia: "AI Status: Inactive" vira regra de desligamento do agente
 * (H89). É o mecanismo que o Hub já mostra ("Regras de desligamento"), agora
 * honrado no webhook, no processor e no runner de follow-up.
 *
 * Sobre a regra por tag `ai qualification inactive` que já existia: o workflow
 * da conta ("TAG Inactive -> AI Status Inactive -> remove tag") ADICIONA a tag,
 * seta o campo e REMOVE a tag no mesmo passo. A regra por tag nunca enxergava
 * a tag; o campo é o estado que fica. Por isso a regra certa é pelo campo.
 *
 * Rodar: npx tsx scripts/apply-marcia-regra-ai-status.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });
import type { DeactivationRule } from "@/types/agent";

const APPLY = process.argv.includes("--apply");
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const REGRA: DeactivationRule = { id: "ai-status-inactive", type: "custom_field_equals", field_key: "EVbZXt7c2AM5dqI9DTcb", field_value: "Inactive" };
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await sb.from("agent_configs").select("deactivation_rules").eq("agent_id", AGENT).single();
  const atuais = ((data as { deactivation_rules?: DeactivationRule[] })?.deactivation_rules ?? []);
  const jaTem = atuais.some((r) => r.type === "custom_field_equals" && r.field_key === REGRA.field_key && r.field_value === REGRA.field_value);
  console.log(`regras hoje: ${atuais.length} | já tem a de AI Status: ${jaTem}`);
  if (jaTem) { console.log("nada a fazer"); return; }
  const novas = [REGRA, ...atuais];
  if (!APPLY) { console.log("(dry-run) ficaria:", JSON.stringify(novas.map((r) => r.id ?? r.tag))); return; }
  const { error } = await sb.from("agent_configs").update({ deactivation_rules: novas }).eq("agent_id", AGENT);
  console.log(error ? `❌ ${error.message}` : `✅ regra adicionada (${novas.length} regras)`);
}
main();
