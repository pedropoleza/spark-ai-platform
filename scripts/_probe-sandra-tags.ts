// Probe read-only: tags/atribuição da Sandra (6kRIwDoc8DOwxrFV3obP) na conta
// da Jussara — pra identificar qual folha de targeting casou em 19/08.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const LOCATION_ID = "pGl5pqLLG0QDixANpFnP";
const CONTACT_ID = "6kRIwDoc8DOwxrFV3obP";

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();
  const { data: loc } = await sb
    .from("locations")
    .select("company_id, timezone")
    .eq("location_id", LOCATION_ID)
    .single();
  if (!loc) throw new Error("location não encontrada");

  const { GHLClient } = await import("@/lib/ghl/client");
  const client = new GHLClient(loc.company_id, LOCATION_ID);
  const res = await client.get<{ contact: Record<string, unknown> }>(
    `/contacts/${CONTACT_ID}`
  );
  const c = res.contact || (res as unknown as Record<string, unknown>);
  const pick = (k: string) => (c as Record<string, unknown>)[k];
  console.log(JSON.stringify({
    name: pick("contactName") || `${pick("firstName") || ""} ${pick("lastName") || ""}`,
    tags: pick("tags"),
    dateAdded: pick("dateAdded"),
    source: pick("source"),
    attributionSource: pick("attributionSource"),
    lastAttributionSource: pick("lastAttributionSource"),
    assignedTo: pick("assignedTo"),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
