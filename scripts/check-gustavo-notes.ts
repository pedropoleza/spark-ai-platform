import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

async function main() {
  const c = new GHLClient("TdmQMjj86Y3LgppiB96K", "b1ttBRVEnm5joFvP2UXO");

  const targets = [
    { name: "Murilo Cerqueira", id: "NLv65hoyZCe0gzdGUinx", afterIso: "2026-05-19T14:00:00Z" },
    { name: "Marcio Rogerio", id: "5ka6PXPlijjE9nUPDDz0", afterIso: "2026-05-19T14:00:00Z" },
    { name: "Roberto Plafoni", id: "4tBN2NkGIiA3vWll483w", afterIso: "2026-05-19T14:00:00Z" },
    { name: "Telma Camargo", id: "h2dZWK0Kh9A2A3zfjzK9", afterIso: "2026-05-19T14:08:00Z" },
    { name: "Kalitha Sulpino", id: "YyDhhV8MQKAakqGyusZg", afterIso: "2026-05-19T14:08:00Z" },
    { name: "Claudia Coelho", id: "ZvNk09Bd0waNNe9AtOmo", afterIso: "2026-05-19T14:08:00Z" },
  ];

  for (const t of targets) {
    try {
      const r = await c.get<{ notes?: Array<{ dateAdded: string; body?: string }> }>(
        `/contacts/${t.id}/notes/`,
      );
      const notes = r.notes || [];
      const afterTs = new Date(t.afterIso).getTime();
      const recent = notes.filter((n) => new Date(n.dateAdded).getTime() > afterTs);
      console.log(`${t.name}: total=${notes.length}, recent_after_${t.afterIso}=${recent.length}`);
      for (const n of recent.slice(0, 3)) {
        console.log(`  ${n.dateAdded} — ${(n.body || "").slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`${t.name}: FAIL ${e instanceof Error ? e.message.slice(0, 150) : e}`);
    }
  }
}
main();
