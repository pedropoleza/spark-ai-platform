/**
 * Cria a oportunidade Catlin & Pablo (casal) no funil — gap da varredura final.
 *   npx tsx -r tsconfig-paths/register scripts/exec-opp-catlin.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { getPipelines } from "../src/lib/ghl/operations";
import { executeTool } from "../src/lib/account-assistant/tools";
import type { ToolContext } from "../src/lib/account-assistant/tools/types";

const REP_ID = "1eeb02cc-1a48-4b56-b177-52dcbca07ac2";
const LOCATION = "efZEjK6PqtPGDHqB2vV6";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

async function main() {
  const supabase = createAdminClient();
  const { data: rep } = await supabase.from("rep_identities").select("*").eq("id", REP_ID).single();
  const ghlClient = new GHLClient(COMPANY, LOCATION);
  const ctx: ToolContext = { rep: rep as ToolContext["rep"], locationId: LOCATION, companyId: COMPANY, ghlClient, testSessionId: null, confirmationMode: "high_only" };

  const { pipelines } = await getPipelines(ghlClient, LOCATION);
  console.log("Pipelines:", (pipelines || []).map((p) => p.name).join(" | "));
  // Escolhe o funil de vendas/prospect; senão o 1º.
  const pipe = (pipelines || []).find((p) => /venda|sales|prospect|lead|funil/i.test(p.name || "")) || (pipelines || [])[0];
  if (!pipe) { console.log("❌ nenhum pipeline"); process.exit(1); }
  const stage = (pipe.stages || [])[0];
  console.log(`Usando pipeline "${pipe.name}" / 1ª etapa "${stage?.name}"`);

  // contato da Catlin
  const r = await executeTool("search_contacts", { query: "8572372439" }, ctx);
  const cid = (r.data as { contacts?: Array<{ id: string }> })?.contacts?.[0]?.id;
  if (!cid) { console.log("❌ Catlin não achada"); process.exit(1); }

  const opp = await executeTool("create_opportunity", {
    contact_id: cid, pipeline_id: pipe.id, ...(stage ? { stage_id: stage.id } : {}),
    name: "Catlin & Pablo (casal — produzem junto)", status: "open", confirmed_by_rep: true,
  }, ctx);
  console.log(`Oportunidade: ${opp.status === "ok" ? "✅ criada (" + pipe.name + " / " + (stage?.name || "?") + ")" : "❌ " + opp.message}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
