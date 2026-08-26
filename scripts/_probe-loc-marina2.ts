// READ-ONLY: o que existe em cada uma das 2 contas da Marina (contatos, calendários,
// tags relevantes) — pra decidir ONDE o pós-atendimento deve rodar.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const IDS: Record<string, string> = {
  "Personal (ONRf...)": "ONRf1DUKVnfxivEGxcTj",
  "Support (A62s...)": "A62s5EQj1hldOuvBEowv",
};

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();

  for (const [label, id] of Object.entries(IDS)) {
    const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", id).single();
    if (!loc) { console.log(`\n### ${label}: fora da tabela locations`); continue; }
    const c = new GHLClient(loc.company_id, id);
    console.log(`\n### ${label}  ${id}`);

    try {
      const r = await c.post<{ total?: number }>("/contacts/search", { locationId: id, pageLimit: 1 });
      console.log(`  contatos: ${r.total ?? "?"}`);
    } catch (e) { console.log(`  contatos: erro ${e instanceof Error ? e.message.slice(0, 90) : e}`); }

    try {
      const r = await c.get<{ calendars?: { id: string; name: string; isActive?: boolean }[] }>("/calendars/", { locationId: id });
      console.log(`  calendários: ${(r.calendars || []).map((x) => `${x.name}${x.isActive === false ? " (off)" : ""}`).join(" | ") || "nenhum"}`);
    } catch (e) { console.log(`  calendários: erro ${e instanceof Error ? e.message.slice(0, 90) : e}`); }

    try {
      const r = await c.get<{ tags?: { name: string }[] }>(`/locations/${id}/tags`);
      const tags = (r.tags || []).map((t) => t.name);
      const rel = tags.filter((t) => /pos|atend|ia|encontro|webinar|registro/i.test(t));
      console.log(`  tags: ${tags.length} no total`);
      console.log(`  tags relevantes: ${rel.slice(0, 25).join(", ") || "nenhuma"}`);
      console.log(`  já existe pos-atendimento-ia? ${tags.some((t) => t.toLowerCase() === "pos-atendimento-ia") ? "SIM" : "não"}`);
      console.log(`  já existe enviar-pos-atendimento? ${tags.some((t) => t.toLowerCase() === "enviar-pos-atendimento") ? "SIM" : "não"}`);
    } catch (e) { console.log(`  tags: erro ${e instanceof Error ? e.message.slice(0, 90) : e}`); }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
