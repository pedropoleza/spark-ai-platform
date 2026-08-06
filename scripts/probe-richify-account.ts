/**
 * Read-only: inspeciona a conta da Richify.us (Willian Poubel + Yolanda Pessanha,
 * location VKJITQwWwWVRzce0dbSb) pra montar os agentes lead-facing (venda +
 * recrutamento) a partir da base de conhecimento entregue pelo cliente.
 * NÃO escreve nada — nem no DB nem no GHL.
 *
 *   npx tsx -r tsconfig-paths/register scripts/probe-richify-account.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K";
const LOCATION = "VKJITQwWwWVRzce0dbSb";

async function main() {
  const supabase = createAdminClient();

  console.log("=== AGENTES NO DB (location Richify) ===");
  const { data: agents, error: ae } = await supabase
    .from("agents")
    .select("id, type, status, name, audience, template_key, created_at")
    .eq("location_id", LOCATION);
  if (ae) console.log(`  ERRO: ${ae.message}`);
  else if (!agents?.length) console.log("  (nenhum agente)");
  else
    for (const a of agents)
      console.log(`  ${a.type} | ${a.status} | audience=${a.audience} | "${a.name}" | ${a.id} | ${a.created_at}`);

  for (const a of agents || []) {
    const { data: cfg } = await supabase
      .from("agent_configs")
      .select("*")
      .eq("agent_id", a.id)
      .maybeSingle();
    if (!cfg) {
      console.log(`  → config de ${a.type}: NENHUMA`);
      continue;
    }
    const c = cfg as Record<string, unknown>;
    console.log(`  → config de ${a.type}: model=${c.ai_model} obj=${c.objective} cal=${c.calendar_id || "(vazio)"}`);
    console.log(
      `     personality=${JSON.stringify(c.personality)?.slice(0, 200)} | custom_instructions=${String(c.custom_instructions || "").length} chars | KB=${String(c.knowledge_base_instructions || "").length} chars`
    );
    console.log(`     targeting=${JSON.stringify(c.targeting_rules)} | channels=${JSON.stringify(c.enabled_channels)}`);
  }

  console.log("\n=== REPS (SparkBot) NA LOCATION ===");
  const { data: reps } = await supabase
    .from("rep_identities")
    .select("id, full_name, phone, ghl_user_id, is_internal, terms_accepted_at, active_location_id")
    .eq("active_location_id", LOCATION);
  for (const r of reps || [])
    console.log(`  ${r.full_name} | ${r.phone} | ghl_user=${r.ghl_user_id} | internal=${r.is_internal} | terms=${r.terms_accepted_at ? "ok" : "-"}`);

  const client = new GHLClient(COMPANY, LOCATION);

  console.log("\n=== LOCATION ===");
  try {
    const loc = await client.get<any>(`/locations/${LOCATION}`);
    const l = loc.location || loc;
    console.log(`  name="${l.name}" | tz=${l.timezone} | ${l.city || ""}/${l.state || ""} | site=${l.website || ""}`);
  } catch (e) {
    console.log(`  ERRO location: ${e instanceof Error ? e.message : e}`);
  }

  console.log("\n=== USUÁRIOS ===");
  try {
    const u = (await client.get<{ users: any[] }>(`/users/`, { locationId: LOCATION })).users || [];
    for (const usr of u) {
      const nm = `${usr.firstName || ""} ${usr.lastName || ""}`.trim() || usr.name || "";
      console.log(`  id=${usr.id} | ${nm} | ${usr.email || ""} | ${usr.phone || ""} | role=${usr.roles?.role || ""}`);
    }
  } catch (e) {
    console.log(`  ERRO users: ${e instanceof Error ? e.message : e}`);
  }

  console.log("\n=== CALENDÁRIOS ===");
  try {
    const r = await client.get<{ calendars: any[] }>(`/calendars/`, { locationId: LOCATION });
    const cals = r.calendars || [];
    if (!cals.length) console.log("  (nenhum calendário)");
    for (const c of cals) {
      console.log(
        `  id=${c.id} | "${c.name}" | active=${c.isActive} | slot=${c.slotDuration}${c.slotDurationUnit || "mins"} | team=${JSON.stringify((c.teamMembers || []).map((t: any) => t.userId || t))}`
      );
      if (c.locationConfigurations) console.log(`      locationConfigurations=${JSON.stringify(c.locationConfigurations)}`);
      if (c.eventType) console.log(`      eventType=${c.eventType} | widget=${c.widgetType || ""}`);
    }
  } catch (e) {
    console.log(`  ERRO calendars: ${e instanceof Error ? e.message : e}`);
  }

  console.log("\n=== CUSTOM FIELDS ===");
  try {
    let cf: any[] = [];
    try {
      cf = (await client.get<{ customFields: any[] }>(`/locations/${LOCATION}/customFields`)).customFields || [];
    } catch {
      cf = (await client.get<{ customFields: any[] }>(`/customFields`, { locationId: LOCATION })).customFields || [];
    }
    console.log(`  ${cf.length} field(s):`);
    for (const f of cf)
      console.log(
        `  id=${f.id} | "${f.name}" | key=${f.fieldKey || f.key || ""} | type=${f.dataType || f.type || ""}${f.picklistOptions ? ` | opts=${JSON.stringify(f.picklistOptions)}` : ""}`
      );
  } catch (e) {
    console.log(`  ERRO customFields: ${e instanceof Error ? e.message : e}`);
  }

  console.log("\n=== PIPELINES ===");
  try {
    const p = (await client.get<{ pipelines: any[] }>(`/opportunities/pipelines`, { locationId: LOCATION })).pipelines || [];
    for (const pl of p) {
      console.log(`  id=${pl.id} | "${pl.name}"`);
      for (const s of pl.stages || []) console.log(`      stage=${s.id} | "${s.name}"`);
    }
  } catch (e) {
    console.log(`  ERRO pipelines: ${e instanceof Error ? e.message : e}`);
  }

  console.log("\n=== TAGS EM USO (amostra de contatos) ===");
  try {
    const r = await client.get<any>(`/contacts/`, { locationId: LOCATION, limit: "100" });
    const contacts = r.contacts || [];
    const tagCount = new Map<string, number>();
    for (const c of contacts) for (const t of c.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    console.log(`  ${contacts.length} contato(s) na amostra | total location=${r.meta?.total ?? "?"}`);
    for (const [t, n] of [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30))
      console.log(`  ${n}x  ${t}`);
  } catch (e) {
    console.log(`  ERRO contacts: ${e instanceof Error ? e.message : e}`);
  }

  console.log("\n=== KBs DISPONÍVEIS (knowledge_bases) ===");
  try {
    const { data: kbs } = await supabase.from("knowledge_bases").select("key, name, scope, location_id").limit(50);
    for (const k of kbs || []) console.log(`  ${k.key} | "${k.name}" | scope=${k.scope} | loc=${k.location_id || "-"}`);
  } catch (e) {
    console.log(`  (sem tabela knowledge_bases ou erro: ${e instanceof Error ? e.message : e})`);
  }

  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
