/**
 * One-off READ-ONLY (Pedro 2026-06-19): inspeciona a forma dos GRUPOS-como-CONTATO
 * na conta do Matheus (location RkFnbOYKJvJfBEaU1ycO). Pedro disse: grupos são
 * contatos normais com o JID no email e "group" no fim. Confirma o shape +
 * lista quantos grupos existem. Não escreve nada.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/read-matheus-group-contacts.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "RkFnbOYKJvJfBEaU1ycO";
const EXAMPLE_CONTACT = "ElZxgh28rNeAxhIku5Iu";

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", LOCATION_ID)
    .maybeSingle();
  if (!loc?.company_id) throw new Error("location sem company_id");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  // 1. Contato-exemplo: dump dos campos relevantes.
  console.log("===== CONTATO EXEMPLO =====");
  try {
    const { contact } = await client.get<{ contact: Record<string, unknown> }>(
      `/contacts/${EXAMPLE_CONTACT}`,
    );
    const keys = ["id", "firstName", "lastName", "contactName", "name", "email", "phone", "type", "source", "tags"];
    const slim: Record<string, unknown> = {};
    for (const k of keys) if (contact[k] !== undefined) slim[k] = contact[k];
    console.log(JSON.stringify(slim, null, 2));
  } catch (e) {
    console.log("erro ao buscar contato exemplo:", e instanceof Error ? e.message : e);
  }

  // 2. Varre contatos procurando os que parecem GRUPO (email/identificador @g.us).
  console.log("\n===== VARREDURA DE GRUPOS (email contém @g.us / 'group') =====");
  const queries = ["g.us", "group", "@g"];
  const seen = new Map<string, Record<string, unknown>>();
  for (const q of queries) {
    try {
      const r = await client.get<{ contacts?: Array<Record<string, unknown>> }>("/contacts/", {
        locationId: LOCATION_ID,
        query: q,
        limit: "100",
      });
      for (const c of r.contacts || []) seen.set(String(c.id), c);
    } catch (e) {
      console.log(`query "${q}" erro:`, e instanceof Error ? e.message : e);
    }
  }

  const all = Array.from(seen.values());
  // Heurística de grupo: email OU phone OU name contém @g.us, ou name termina em "group".
  const looksGroup = (c: Record<string, unknown>) => {
    const email = String(c.email || "").toLowerCase();
    const phone = String(c.phone || "").toLowerCase();
    const name = String(c.contactName || c.name || `${c.firstName || ""} ${c.lastName || ""}`).toLowerCase();
    return /@g\.us/.test(email) || /@g\.us/.test(phone) || /@g\.us/.test(name) || /group\b/.test(name);
  };
  const groups = all.filter(looksGroup);

  console.log(`contatos retornados pelas queries: ${all.length} | parecem grupo: ${groups.length}\n`);
  for (const g of groups.slice(0, 40)) {
    const name = g.contactName || g.name || `${g.firstName || ""} ${g.lastName || ""}`.trim();
    console.log(`- nome="${name}" | email=${g.email || "-"} | phone=${g.phone || "-"} | id=${g.id}`);
  }
  if (groups.length === 0 && all.length > 0) {
    console.log("Nenhum casou a heurística. Amostra do que veio (pra eu ajustar o padrão):");
    for (const c of all.slice(0, 8)) {
      console.log(`  nome="${c.contactName || c.name || ""}" email=${c.email || "-"} phone=${c.phone || "-"}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
