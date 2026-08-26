// READ-ONLY: qual é cada location? (banco não tem location_name preenchido)
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const IDS = ["ONRf1DUKVnfxivEGxcTj", "A62s5EQj1hldOuvBEowv"];

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();

  for (const id of IDS) {
    const { data: loc } = await sb
      .from("locations")
      .select("company_id")
      .eq("location_id", id)
      .single();
    if (!loc) {
      console.log(`${id}: NÃO está na tabela locations`);
      continue;
    }
    const client = new GHLClient(loc.company_id, id);
    try {
      const r = await client.get<{ location?: Record<string, unknown> }>(`/locations/${id}`);
      const L = (r.location || {}) as Record<string, unknown>;
      console.log(
        `${id}\n  nome: ${L.name}\n  business: ${(L.business as { name?: string })?.name ?? "-"}\n  email: ${L.email}\n  phone: ${L.phone}\n  tz: ${L.timezone}\n`,
      );
    } catch (e) {
      console.log(`${id}: erro ao ler → ${e instanceof Error ? e.message : e}\n`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
