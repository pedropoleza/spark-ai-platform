// READ-ONLY — mapeia as contas da Bianca: nome real das locations do company
// TdmQMjj86Y3LgppiB96K + amostra de atribuição (UTM/anúncio) nos contatos.
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();

  const { data: locs } = await sb
    .from("locations")
    .select("location_id, company_id, timezone")
    .eq("company_id", "TdmQMjj86Y3LgppiB96K");

  console.log(`=== locations do company TdmQMjj86Y3LgppiB96K: ${locs?.length || 0} ===`);
  for (const l of locs || []) {
    const client = new GHLClient(l.company_id, l.location_id);
    try {
      const r = await client.get<{ location?: { name?: string; timezone?: string } }>(
        `/locations/${l.location_id}`
      );
      const nAgents = await sb
        .from("agents")
        .select("id,name,status", { count: "exact" })
        .eq("location_id", l.location_id);
      console.log(
        `${l.location_id} | ${r.location?.name || "?"} | tz=${r.location?.timezone} | agentes=${(nAgents.data || []).map((a) => `${a.name}[${a.status}]`).join(" · ") || "—"}`
      );
    } catch (e) {
      console.log(`${l.location_id} | ERRO: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
