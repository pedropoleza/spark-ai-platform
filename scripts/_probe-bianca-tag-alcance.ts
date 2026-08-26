// READ-ONLY — quantos contatos JÁ têm as tags de gatilho? Com o H82 no ar, um
// ContactUpdate qualquer nesses contatos dispara a abertura proativa da IA.
// Precisa ser medido ANTES de deixar o agente ligado.
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "cRavIlyC52vFYgJATgi7";
const TAGS = ["novo seguidor", "ia-ligada"];

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  const c = new GHLClient(loc!.company_id, LOC);

  for (const tag of TAGS) {
    const r = await c.post<{ total?: number; contacts?: Array<{ id: string; contactName?: string; dateAdded?: string }> }>(
      "/contacts/search",
      { locationId: LOC, pageLimit: 20, filters: [{ field: "tags", operator: "eq", value: tag }] },
    );
    const total = r.total ?? (r.contacts || []).length;
    console.log(`\n=== tag "${tag}": ${total} contato(s) ===`);
    for (const ct of (r.contacts || []).slice(0, 10)) {
      // Já existe conversa com o agente B? Se sim, a guarda anti-reabertura protege.
      const { count } = await sb
        .from("conversation_state")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", "47cdcb0d-5840-4ae4-bc8b-b60e70870b50")
        .eq("contact_id", ct.id);
      console.log(`   ${(ct.contactName || "?").slice(0, 26).padEnd(26)} add=${(ct.dateAdded || "").slice(0, 10)} conversa_com_B=${count ?? 0}`);
    }
    if (total > 10) console.log(`   … e mais ${total - 10}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
