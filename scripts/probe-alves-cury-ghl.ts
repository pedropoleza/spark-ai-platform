/**
 * Read-only: inspeciona o GHL da Alves Cury Financial pra portar os agentes do
 * N8n (Bruna/vendas + Bruno/recrutamento). NÃO envia nada.
 * Objetivos:
 *  1) achar o custom field "AI" (valores Venda/Recruit) -> id pro targeting split
 *  2) confirmar os 2 calendários (vendas TqJj9pWtu4JkieXilC54 / recrut 3tVbOYTMbFQHpzZfpf4h)
 *     e se a entrega do Zoom é automática (meetingLocation/notifications)
 *  3) confirmar usuários (Taciana especialista de recrut / Marcos owner)
 *   npx tsx -r tsconfig-paths/register scripts/probe-alves-cury-ghl.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "YuR0LCZomFzrfkDK2ezo";
const CAL_SALES = "TqJj9pWtu4JkieXilC54";
const CAL_RECRUIT = "3tVbOYTMbFQHpzZfpf4h";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);

  // 1) CUSTOM FIELDS -----------------------------------------------------
  console.log("\n=== CUSTOM FIELDS (procurando 'AI') ===");
  let cf: any[] = [];
  try {
    cf = (await client.get<{ customFields: any[] }>(`/locations/${LOCATION}/customFields`)).customFields || [];
  } catch {
    cf = (await client.get<{ customFields: any[] }>(`/customFields`, { locationId: LOCATION })).customFields || [];
  }
  console.log(`${cf.length} custom field(s). Candidatos (AI / Venda / Recruit / assistant):`);
  for (const f of cf) {
    const hay = `${f.name || ""} ${f.fieldKey || f.key || ""}`.toLowerCase();
    if (/\bai\b|venda|recruit|assist|qualif/.test(hay)) {
      console.log(`  >>> id=${f.id} | name="${f.name}" | key=${f.fieldKey || f.key || ""} | type=${f.dataType || f.type || ""} | opts=${JSON.stringify(f.picklistOptions || f.options || "")}`);
    }
  }

  // 2) CALENDÁRIOS -------------------------------------------------------
  for (const [label, id] of [["VENDAS", CAL_SALES], ["RECRUT", CAL_RECRUIT]] as const) {
    console.log(`\n=== CALENDÁRIO ${label} (${id}) ===`);
    try {
      const r = await client.get<any>(`/calendars/${id}`);
      const c = r.calendar || r;
      console.log(`  name="${c.name}" | teamMembers=${JSON.stringify((c.teamMembers || []).map((t: any) => t.userId || t))}`);
      // Dump só das chaves que importam pro meio da reunião (zoom/custom/phone).
      const keys = ["locationConfigurations", "meetingLocation", "eventType", "widgetType", "calendarType", "location", "appoinmentPerSlot", "notifications"];
      for (const k of keys) if (c[k] !== undefined) console.log(`  ${k}=${JSON.stringify(c[k])}`);
    } catch (e) {
      console.log(`  ERRO calendário ${label}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3) USUÁRIOS ----------------------------------------------------------
  console.log("\n=== USUÁRIOS (Taciana / Marcos) ===");
  try {
    const u = (await client.get<{ users: any[] }>(`/users/`, { locationId: LOCATION })).users || [];
    for (const usr of u) {
      const nm = `${usr.firstName || ""} ${usr.lastName || ""} ${usr.name || ""}`.trim();
      console.log(`  id=${usr.id} | ${nm} | ${usr.email || ""} | role=${usr.roles?.role || usr.role || ""}`);
    }
  } catch (e) {
    console.log(`  ERRO users: ${e instanceof Error ? e.message : e}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
