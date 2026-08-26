// READ-ONLY — Bianca (Five Rings cRavIlyC52vFYgJATgi7): os contatos têm
// attributionSource/UTM utilizável pra separar tráfego pago × seguidor orgânico?
// Espelha o probe do caso Marina (H74).
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = process.argv[2] || "cRavIlyC52vFYgJATgi7";

type Contact = {
  id: string;
  contactName?: string;
  dateAdded?: string;
  tags?: string[];
  attributionSource?: Record<string, unknown> | null;
  lastAttributionSource?: Record<string, unknown> | null;
};

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  if (!loc) throw new Error("location não cadastrada");
  const client = new GHLClient(loc.company_id, LOC);

  // contacts_search_v2: pega os mais recentes
  const res = await client.post<{ contacts?: Contact[]; total?: number }>("/contacts/search", {
    locationId: LOC,
    pageLimit: 100,
    sort: [{ field: "dateAdded", direction: "desc" }],
  });
  const contacts = res.contacts || [];
  console.log(`=== ${LOC} — ${contacts.length} contatos recentes (total na conta: ${res.total ?? "?"}) ===\n`);

  const cont = (o: Record<string, unknown> | null | undefined, k: string) =>
    o && typeof o[k] === "string" ? String(o[k]) : "";

  const bySession = new Map<string, number>();
  const byMedium = new Map<string, number>();
  const byCampaign = new Map<string, number>();
  let semAtrib = 0;
  const exemplos: string[] = [];

  for (const c of contacts) {
    const a = c.attributionSource || null;
    const l = c.lastAttributionSource || null;
    const ss = cont(a, "sessionSource");
    const md = cont(a, "medium");
    const cp = cont(a, "campaign") || cont(a, "utmCampaign") || cont(a, "utm_campaign");
    if (!a && !l) semAtrib++;
    bySession.set(ss || "(vazio)", (bySession.get(ss || "(vazio)") || 0) + 1);
    byMedium.set(md || "(vazio)", (byMedium.get(md || "(vazio)") || 0) + 1);
    if (cp) byCampaign.set(cp, (byCampaign.get(cp) || 0) + 1);
    if (exemplos.length < 6 && a && Object.keys(a).length > 0) {
      exemplos.push(
        `${(c.contactName || "?").slice(0, 22).padEnd(22)} | add=${(c.dateAdded || "").slice(0, 10)} | tags=[${(c.tags || []).slice(0, 3).join(", ")}]\n   first=${JSON.stringify(a)}\n   last =${JSON.stringify(l)}`
      );
    }
  }

  const show = (label: string, m: Map<string, number>) => {
    console.log(`--- ${label} ---`);
    [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
    console.log();
  };
  show("sessionSource (1º toque)", bySession);
  show("medium (1º toque)", byMedium);
  if (byCampaign.size) show("campaign/utm", byCampaign);
  console.log(`contatos SEM atribuição nenhuma: ${semAtrib}/${contacts.length}\n`);
  console.log("=== EXEMPLOS CRUS ===");
  exemplos.forEach((e) => console.log(e + "\n"));
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
