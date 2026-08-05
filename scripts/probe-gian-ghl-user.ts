/**
 * Diagnóstico (2026-07-23, caso Gian/Fabiana location 7pXJ): o bot não consegue
 * listar a agenda porque o ghl_user_id armazenado (n9NEOUXDRi512cS7xNeT) foi
 * DELETADO no Spark Leads ("The user is deleted." 400). Este probe lista os
 * usuários REAIS da location pra descobrir se o Gian foi recriado com id novo
 * (corrigível: update no rep_identity) ou removido de vez (readd no CRM).
 *
 * READ-ONLY. Rodar: npx tsx scripts/probe-gian-ghl-user.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";
import { listLocationUsers } from "@/lib/ghl/operations";
import { createAdminClient } from "@/lib/supabase/admin";

const LOCATION = "7pXJZ8WUq0GpVh0Qd2Ew";
const STALE_IDS = ["n9NEOUXDRi512cS7xNeT", "cEZ0G6J4aUWjSuw5OQF3"]; // Gian + Fabiana

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id, location_name")
    .eq("location_id", LOCATION)
    .maybeSingle();
  if (!loc?.company_id) {
    console.error("Location sem company_id no DB.");
    process.exit(1);
  }
  console.log(`Location: ${loc.location_name} (${LOCATION}) company=${loc.company_id}\n`);

  const client = new GHLClient(loc.company_id, LOCATION);
  let res;
  try {
    res = await listLocationUsers(client, LOCATION);
  } catch (err) {
    console.error("Falha ao listar usuários GHL:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const users = res.users || [];
  console.log(`Usuários REAIS no Spark Leads (${users.length}):`);
  for (const u of users) {
    const name = u.name || [u.firstName, u.lastName].filter(Boolean).join(" ");
    const stale = STALE_IDS.includes(u.id) ? " ⬅️ (id armazenado ainda válido!)" : "";
    console.log(`  ${u.id}  ${name}  <${u.email || "?"}>  role=${u.roles?.role || "?"}${stale}`);
  }

  console.log("\n--- Diagnóstico ---");
  for (const staleId of STALE_IDS) {
    const found = users.find((u) => u.id === staleId);
    console.log(`  ${staleId}: ${found ? "AINDA EXISTE (não é o problema)" : "DELETADO ✗ (não está mais na location)"}`);
  }
  const gian = users.find((u) => {
    const n = (u.name || `${u.firstName || ""} ${u.lastName || ""}`).toLowerCase();
    return n.includes("gian");
  });
  console.log(`  Gian recriado? ${gian ? `SIM → id novo = ${gian.id} (corrigível: update rep_identity)` : "NÃO achei 'Gian' na lista — precisa readd no CRM"}`);
}

main();
