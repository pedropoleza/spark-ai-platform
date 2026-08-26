// Probe read-only: busca a mensagem uyfreT2edMeBcW7BXTPn na API do Spark Leads
// (location da Jussara) pra saber direção/source/autor. Não escreve nada.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const LOCATION_ID = "pGl5pqLLG0QDixANpFnP";
const MESSAGE_ID = "uyfreT2edMeBcW7BXTPn";

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();
  const { data: loc, error } = await sb
    .from("locations")
    .select("company_id, location_id, timezone")
    .eq("location_id", LOCATION_ID)
    .single();
  if (error || !loc) {
    console.error("location não encontrada:", error?.message);
    process.exit(1);
  }
  console.log("location tz:", loc.timezone);

  const { GHLClient } = await import("@/lib/ghl/client");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  try {
    const msg = await client.get<Record<string, unknown>>(
      `/conversations/messages/${MESSAGE_ID}`
    );
    console.log("=== mensagem ===");
    console.log(JSON.stringify(msg, null, 2));
  } catch (e) {
    console.error("GET message falhou:", e instanceof Error ? e.message : e);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("ERR:", e?.message || e);
  process.exit(1);
});
