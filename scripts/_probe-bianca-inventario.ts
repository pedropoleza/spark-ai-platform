// READ-ONLY — inventário da conta da Bianca (Five Rings): tags, calendários,
// pipelines/estágios e usuários. Base pro plano de separação dos agentes.
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = process.argv[2] || "cRavIlyC52vFYgJATgi7";

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  if (!loc) throw new Error("location não cadastrada");
  const c = new GHLClient(loc.company_id, LOC);

  const tags = await c.get<{ tags?: Array<{ id: string; name: string }> }>(`/locations/${LOC}/tags`).catch((e) => { console.log("tags ERRO:", e.message); return { tags: [] }; });
  const lista = (tags.tags || []).map((t) => t.name).sort();
  console.log(`=== TAGS (${lista.length}) ===`);
  console.log(lista.join(" · "));
  const suspeitas = lista.filter((t) => /ia|ai|bot|seguidor|follow|anunc|ads|paid|trafego|tráfego/i.test(t));
  console.log(`\n--- tags que cheiram a IA/origem (${suspeitas.length}) ---\n${suspeitas.join(" · ") || "(nenhuma)"}`);

  const cals = await c.get<{ calendars?: Array<{ id: string; name: string; isActive?: boolean }> }>("/calendars/", { locationId: LOC }).catch(() => ({ calendars: [] }));
  console.log(`\n=== CALENDÁRIOS (${(cals.calendars || []).length}) ===`);
  for (const cal of cals.calendars || []) console.log(`  ${cal.id} | ${cal.name} | ativo=${cal.isActive}`);

  const pipes = await c.get<{ pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> }>("/opportunities/pipelines", { locationId: LOC }).catch((e) => { console.log("pipelines ERRO:", e.message); return { pipelines: [] }; });
  console.log(`\n=== PIPELINES (${(pipes.pipelines || []).length}) ===`);
  for (const p of pipes.pipelines || []) {
    console.log(`  ${p.name} (${p.id})`);
    for (const s of p.stages || []) console.log(`      - ${s.name} (${s.id})`);
  }

  const users = await c.get<{ users?: Array<{ id: string; name: string; email: string; roles?: { role?: string } }> }>("/users/", { locationId: LOC }).catch(() => ({ users: [] }));
  console.log(`\n=== USUÁRIOS (${(users.users || []).length}) ===`);
  for (const u of users.users || []) console.log(`  ${u.id} | ${u.name} | ${u.email} | ${u.roles?.role || "?"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
