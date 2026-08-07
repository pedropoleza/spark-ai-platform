/**
 * Corrige `locations.timezone` usando a API do Spark Leads como fonte da verdade
 * (é exatamente o que o caminho de SSO já faz em `/api/auth/sso`).
 *
 * Contexto (2026-08-06, caso Márcia/Five Star + Richify): o widget do SparkBot
 * gravava em `locations.timezone` o fuso do NAVEGADOR de quem abrisse a página
 * (`/api/sparkbot/check-admin`), e o `/api/agents/ui-auth` resetava pra
 * America/New_York. Resultado: 43 de 117 locations com fuso errado, 38 delas
 * com America/Sao_Paulo em conta americana.
 *
 * Impacto: `locations.timezone` é a fonte do fuso dos agentes lead-facing —
 * formata os horários livres mostrados ao lead, a data/hora do prompt e o
 * offset ISO gravado pelo `book_appointment`. Com BRT (-03:00) numa conta ET
 * (-04:00), a IA oferece "7PM" e grava 18:00 ET: a reunião nasce 1h antes do
 * combinado. É o sintoma que a Márcia reportou em 04, 05 e 06/08.
 *
 * A CAUSA já foi corrigida e deployada (commit bfc8251); este script conserta
 * o estrago que ficou nas linhas.
 *
 *   npx tsx -r tsconfig-paths/register scripts/fix-fuso-locations.ts           # dry-run
 *   npx tsx -r tsconfig-paths/register scripts/fix-fuso-locations.ts --apply
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { writeFileSync } from "fs";

const APPLY = process.argv.includes("--apply");

function offsetMinutes(tz: string, at = new Date()): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

async function main() {
  const supabase = createAdminClient();

  const { data: locs, error } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name, timezone");
  if (error) throw new Error(error.message);

  const { data: agents } = await supabase
    .from("agents")
    .select("location_id, status, name, type")
    .in("type", ["sales_agent", "recruitment_agent", "custom_agent"])
    .eq("status", "active");
  const ativos = new Set((agents || []).map((a) => a.location_id as string));

  const plano: { locationId: string; nome: string; de: string; para: string; deltaH: number; agenteAtivo: boolean }[] = [];
  let semAcesso = 0;

  for (const l of locs || []) {
    const locId = l.location_id as string;
    const nosso = (l.timezone as string) || "";
    let real = "";
    let nomeReal = "";
    try {
      const r = await new GHLClient(l.company_id as string, locId).get<any>(`/locations/${locId}`);
      const loc = r.location || r;
      real = loc.timezone || "";
      nomeReal = loc.name || "";
    } catch {
      semAcesso++;
      continue;
    }
    if (!real || real === nosso) continue;

    const oNosso = offsetMinutes(nosso);
    const oReal = offsetMinutes(real);
    if (oNosso === null || oReal === null) continue;

    plano.push({
      locationId: locId,
      nome: nomeReal || (l.location_name as string) || "(sem nome)",
      de: nosso || "(null)",
      para: real,
      deltaH: (oReal - oNosso) / 60,
      agenteAtivo: ativos.has(locId),
    });
  }

  // Backup do estado ANTES (rollback = reaplicar `de`)
  const backup = `/tmp/fuso-locations-backup-${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify(plano, null, 2));

  const comDelta = plano.filter((p) => p.deltaH !== 0);
  const soNome = plano.filter((p) => p.deltaH === 0);

  console.log(`${plano.length} location(s) divergente(s) | ${comDelta.length} com offset REAL diferente | ${soNome.length} só alias de nome`);
  console.log(`sem acesso ao Spark Leads: ${semAcesso}`);
  console.log(`backup do estado anterior: ${backup}\n`);

  console.log("=== COM AGENTE LEAD-FACING ATIVO (marcando errado agora) ===");
  for (const p of plano.filter((x) => x.agenteAtivo)) {
    console.log(`  ${p.deltaH > 0 ? "+" : ""}${p.deltaH}h | ${p.de} → ${p.para} | ${p.nome} [${p.locationId}]`);
  }

  console.log("\n=== DEMAIS ===");
  for (const p of plano.filter((x) => !x.agenteAtivo)) {
    console.log(`  ${p.deltaH > 0 ? "+" : ""}${p.deltaH}h | ${p.de} → ${p.para} | ${p.nome} [${p.locationId}]`);
  }

  if (!APPLY) {
    console.log(`\n(dry-run — rode com --apply pra gravar)`);
    process.exit(0);
  }

  let ok = 0;
  for (const p of plano) {
    const { error: ue } = await supabase
      .from("locations")
      .update({ timezone: p.para, updated_at: new Date().toISOString() })
      .eq("location_id", p.locationId);
    if (ue) console.log(`  ❌ ${p.locationId}: ${ue.message}`);
    else ok++;
  }
  console.log(`\n✅ ${ok}/${plano.length} location(s) corrigida(s). Backup: ${backup}`);
  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
