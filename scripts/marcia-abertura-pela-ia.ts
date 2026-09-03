/**
 * Conta da Márcia — a abertura passa a ser da IA (decisão do Pedro, 03/09).
 *
 * Enquanto o workflow "Incoming Lead > Message - v81" estiver PUBLICADO, a IA
 * não pode se apresentar (senão duplica: era a queixa das "7 mensagens"), então
 * `suppress_ad_context_turn` fica true. No momento em que o workflow for
 * despublicado no painel, a IA precisa VOLTAR a se apresentar — senão ninguém
 * cumprimenta o lead. Este script lê o status do workflow pela API e deixa a
 * config coerente com ele. Idempotente: pode rodar quantas vezes quiser.
 *
 * Rodar: npx tsx scripts/marcia-abertura-pela-ia.ts [--apply]
 */
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });
import { GHLClient } from "@/lib/ghl/client";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const LOC = "jA6uzx6tONyTeocxw4Cj";
const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const WORKFLOW_ENTRADA = "fa30ba26-fc18-4f09-b445-c19a510bef45"; // Incoming Lead > Message - v81
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const c = new GHLClient("TdmQMjj86Y3LgppiB96K", LOC);
  const w = await c.get<{ workflows?: Array<{ id: string; name: string; status: string }> }>("/workflows/", { locationId: LOC });
  const wf = (w.workflows ?? []).find((x) => x.id === WORKFLOW_ENTRADA);
  const publicado = wf?.status === "published";
  const { data } = await sb.from("agent_configs").select("suppress_ad_context_turn,entry_by_automation").eq("agent_id", AGENT).single();
  const cfg = data as { suppress_ad_context_turn: boolean; entry_by_automation: boolean };

  console.log(`workflow "${wf?.name ?? "?"}": ${publicado ? "PUBLICADO" : "despublicado"}`);
  console.log(`config hoje: suppress_ad_context_turn=${cfg.suppress_ad_context_turn} entry_by_automation=${cfg.entry_by_automation}`);

  // Coerência: workflow ligado → IA não se apresenta; workflow desligado → IA se apresenta.
  const alvo = { suppress_ad_context_turn: publicado, entry_by_automation: publicado };
  const precisa = cfg.suppress_ad_context_turn !== alvo.suppress_ad_context_turn || cfg.entry_by_automation !== alvo.entry_by_automation;
  console.log(`alvo: ${JSON.stringify(alvo)} → ${precisa ? "PRECISA AJUSTAR" : "já coerente"}`);
  if (!precisa) { console.log("COERENTE"); return; }
  if (!APPLY) { console.log("(dry-run — rode com --apply)"); return; }
  const { error } = await sb.from("agent_configs").update(alvo).eq("agent_id", AGENT);
  console.log(error ? `❌ ${error.message}` : `✅ AJUSTADO: ${JSON.stringify(alvo)}`);
}
main();
