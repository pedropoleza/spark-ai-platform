/**
 * One-off (Pedro 2026-06-18): probe READ-ONLY do GET /group/myall do Stevo pra
 * descobrir a forma real da resposta (nome do grupo / JID) — fundação do design
 * da feature de campanhas em grupos. NÃO imprime o token.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/probe-stevo-groups.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const supabase = createAdminClient();
  const { data: inst } = await supabase
    .from("stevo_instances")
    .select("server_url, instance_token, instance_name, hub_location_id")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!inst?.server_url || !inst?.instance_token) throw new Error("sem instância Stevo");
  console.log(`instância=${inst.instance_name} hub=${inst.hub_location_id} server=${inst.server_url}`);

  const tryEndpoints = ["/group/myall", "/group/list"];
  for (const ep of tryEndpoints) {
    try {
      const r = await fetch(`${inst.server_url}${ep}`, {
        method: "GET",
        headers: { apikey: inst.instance_token, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const txt = await r.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(txt); } catch { /* não-json */ }
      console.log(`\n=== GET ${ep} → HTTP ${r.status} ===`);
      if (parsed && typeof parsed === "object") {
        // Acha o array de grupos (pode estar em data/groups/results/raiz).
        const obj = parsed as Record<string, unknown>;
        const arr = Array.isArray(parsed)
          ? (parsed as unknown[])
          : (obj.data as unknown[]) || (obj.groups as unknown[]) || (obj.results as unknown[]) || null;
        console.log("top-level keys:", Array.isArray(parsed) ? "(array)" : Object.keys(obj).join(", "));
        if (Array.isArray(arr)) {
          console.log(`total grupos: ${arr.length}`);
          for (const g of arr.slice(0, 8)) {
            const gg = g as Record<string, unknown>;
            console.log("  campos:", Object.keys(gg).join(","));
            console.log("    nome:", gg.Name || gg.name || gg.subject || gg.Subject || "?",
              "| jid:", gg.JID || gg.jid || gg.id || gg.Id || "?",
              "| participants:", Array.isArray(gg.Participants) ? (gg.Participants as unknown[]).length : (gg.participants ? (gg.participants as unknown[]).length : "?"));
          }
        } else {
          console.log("resposta (300):", txt.slice(0, 300));
        }
      } else {
        console.log("resposta (300):", txt.slice(0, 300));
      }
    } catch (e) {
      console.log(`GET ${ep} ERRO:`, e instanceof Error ? e.message : e);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
