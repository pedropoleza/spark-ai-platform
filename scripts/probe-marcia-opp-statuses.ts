/** Probe READ-ONLY: distribuição de status de opps na location da Marcia. Efêmero. */
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION = "jA6uzx6tONyTeocxw4Cj";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  for (const status of ["open", "won", "lost", "abandoned"]) {
    try {
      const r = await client.get<{ meta?: { total?: number }; opportunities?: unknown[] }>(
        `/opportunities/search?location_id=${LOCATION}&status=${status}&limit=1`,
      );
      console.log(`${status}: total=${r?.meta?.total ?? "?"} (page len=${r?.opportunities?.length ?? 0})`);
    } catch (e) {
      console.log(`${status}: ERR ${e instanceof Error ? e.message.slice(0, 100) : e}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Pipelines + stages pra entender se existe stage "fechado" custom
  try {
    const p = await client.get<{ pipelines?: Array<{ id?: string; name?: string; stages?: Array<{ id?: string; name?: string }> }> }>(
      `/opportunities/pipelines?locationId=${LOCATION}`,
    );
    for (const pipe of p?.pipelines || []) {
      console.log(`pipeline "${pipe.name}" (${pipe.id}):`);
      for (const s of pipe.stages || []) console.log(`  stage "${s.name}" (${s.id})`);
    }
  } catch (e) {
    console.log(`pipelines: ERR ${e instanceof Error ? e.message.slice(0, 100) : e}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
