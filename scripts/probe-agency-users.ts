/**
 * Probe 2026-06-11: enumera os users de AGÊNCIA (role agency_owner/agency_user
 * OU type agency) da company, varrendo as listas de users de várias locations e
 * deduplicando. Serve pra montar a string de ASSISTANT_ALLOWED_AGENCY_USERS.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/probe-agency-users.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";

interface GUser { id: string; name?: string; email?: string; role?: string; type?: string; roles?: { type?: string; role?: string } }

async function main() {
  const supabase = createAdminClient();
  // Varre até 15 locations da company pra maximizar chance de aparecer um agency user.
  const { data: locs } = await supabase
    .from("locations")
    .select("location_id")
    .eq("company_id", COMPANY)
    .limit(15);
  const locationIds = (locs || []).map((l) => l.location_id);
  console.log(`Varrendo ${locationIds.length} locations da company ${COMPANY}...`);

  const agency = new Map<string, { name: string; email: string; role: string; type: string }>();
  const allRolesSeen = new Set<string>();

  for (const lid of locationIds) {
    try {
      const client = new GHLClient(COMPANY, lid);
      const res = await client.get<{ users?: GUser[] }>("/users/", { locationId: lid });
      for (const u of res.users || []) {
        const role = (u.role || u.roles?.role || "").toLowerCase();
        const type = (u.type || u.roles?.type || "").toLowerCase();
        allRolesSeen.add(`${role}/${type}`);
        const isAgency = role === "agency_owner" || role === "agency_user" || type === "agency";
        if (isAgency && u.id) {
          agency.set(u.id, { name: u.name || "", email: u.email || "", role, type });
        }
      }
    } catch (e) {
      console.log(`  [${lid}] users falhou: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }

  console.log(`\nPares role/type vistos: ${[...allRolesSeen].join(", ")}`);
  console.log(`\n=== AGENCY USERS encontrados (${agency.size}) ===`);
  const pairs: string[] = [];
  for (const [id, info] of agency) {
    console.log(`  ${id}  ${info.role}/${info.type}  ${info.name}  <${info.email}>`);
    pairs.push(`${id}:${COMPANY}`);
  }
  console.log(`\n=== String pronta pra ASSISTANT_ALLOWED_AGENCY_USERS ===`);
  console.log(pairs.join(","));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
