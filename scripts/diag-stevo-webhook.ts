/**
 * URGENTE 2026-06-17: SparkBot mudo — webhooks do Stevo pararam de chegar
 * (último em 06-16 22:45). Sonda a API do Stevo pra ver: estado da conexão +
 * config do webhook (URL/eventos). READ-ONLY. Não muda nada.
 *   npx tsx -r tsconfig-paths/register scripts/diag-stevo-webhook.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const HUB = "RBFxlEQZobaDjlF2i5px";

async function probe(label: string, url: string, token: string, method = "GET") {
  try {
    const r = await fetch(url, { method, headers: { apikey: token, "content-type": "application/json" } });
    const t = await r.text();
    console.log(`\n[${label}] ${method} ${url}\n  → ${r.status} ${t.slice(0, 500)}`);
  } catch (e) {
    console.log(`\n[${label}] ${method} ${url}\n  → ERR ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  const sb = createAdminClient();
  const { data: inst } = await sb
    .from("stevo_instances")
    .select("server_url, instance_name, instance_token")
    .eq("hub_location_id", HUB)
    .maybeSingle();
  if (!inst) {
    console.log("sem instancia pro hub");
    process.exit(1);
  }
  const s = inst.server_url.replace(/\/$/, "");
  const n = inst.instance_name;
  const tok = inst.instance_token;
  console.log("server:", s, "| instance:", n, "| token_len:", tok.length);

  // Endpoints REAIS do StevoManager v2 (descobertos no swagger)
  await probe("instance/status", `${s}/instance/status`, tok);
  await probe("instance/profile", `${s}/instance/profile`, tok);

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
