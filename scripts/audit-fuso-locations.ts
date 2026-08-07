/**
 * Read-only: compara `locations.timezone` (nosso banco — fonte do fuso dos
 * agentes lead-facing) com o fuso REAL da location na API do Spark Leads.
 *
 * Por que importa: `locations.timezone` decide (a) como os horários livres são
 * formatados pro lead, (b) a data/hora que vai no prompt e (c) o offset ISO que
 * o `book_appointment` grava. Fuso errado = reunião marcada na hora errada.
 * Causa conhecida (fix 2026-08-06): /api/sparkbot/check-admin gravava o fuso do
 * NAVEGADOR de quem abrisse o widget — usuário brasileiro numa conta americana
 * escrevia America/Sao_Paulo por cima.
 *
 *   npx tsx -r tsconfig-paths/register scripts/audit-fuso-locations.ts [--only-agentes]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";

const onlyAgents = process.argv.includes("--only-agentes");

/** Offset em minutos do fuso num instante (lida com DST). */
function offsetMinutes(tz: string, at = new Date()): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

async function main() {
  const supabase = createAdminClient();

  const { data: locs, error } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name, timezone, updated_at");
  if (error) throw new Error(error.message);

  // Quais locations têm agente lead-facing ATIVO (é onde o fuso errado marca reunião errada)
  const { data: agents } = await supabase
    .from("agents")
    .select("location_id, type, status, name")
    .in("type", ["sales_agent", "recruitment_agent", "custom_agent"]);
  const agentByLoc = new Map<string, { status: string; name: string }[]>();
  for (const a of agents || []) {
    const arr = agentByLoc.get(a.location_id as string) || [];
    arr.push({ status: a.status as string, name: a.name as string });
    agentByLoc.set(a.location_id as string, arr);
  }

  const alvo = (locs || []).filter((l) => {
    if (!onlyAgents) return true;
    return (agentByLoc.get(l.location_id as string) || []).some((a) => a.status === "active");
  });

  console.log(`Auditando ${alvo.length} location(s)${onlyAgents ? " com agente lead-facing ativo" : ""}...\n`);

  const divergentes: string[] = [];
  const comAgenteAtivo: string[] = [];
  let ok = 0;
  let semAcesso = 0;

  for (const l of alvo) {
    const locId = l.location_id as string;
    const nossoTz = (l.timezone as string) || "(null)";
    const ags = agentByLoc.get(locId) || [];
    const ativos = ags.filter((a) => a.status === "active");

    let realTz = "";
    let realName = "";
    try {
      const client = new GHLClient(l.company_id as string, locId);
      const r = await client.get<any>(`/locations/${locId}`);
      const loc = r.location || r;
      realTz = loc.timezone || "";
      realName = loc.name || "";
    } catch {
      semAcesso++;
      continue;
    }
    if (!realTz) { semAcesso++; continue; }

    const offNosso = offsetMinutes(nossoTz);
    const offReal = offsetMinutes(realTz);
    const deltaH = offNosso !== null && offReal !== null ? (offReal - offNosso) / 60 : null;

    if (nossoTz === realTz) { ok++; continue; }

    const label = `${realName || l.location_name || "(sem nome)"} [${locId}]`;
    const linha =
      `  ${deltaH !== null && deltaH !== 0 ? `⛔ ${deltaH > 0 ? "+" : ""}${deltaH}h` : "⚠️  0h"} | nosso=${nossoTz} real=${realTz} | ${label}` +
      (ativos.length ? ` | AGENTE ATIVO: ${ativos.map((a) => a.name).join(", ")}` : "");
    divergentes.push(linha);
    if (ativos.length && deltaH !== 0) comAgenteAtivo.push(linha);
  }

  console.log(`=== DIVERGENTES (${divergentes.length}) ===`);
  for (const d of divergentes.sort()) console.log(d);
  console.log(`\n=== RESUMO ===`);
  console.log(`  ✅ fuso correto: ${ok}`);
  console.log(`  ⛔ divergentes: ${divergentes.length}`);
  console.log(`  🔥 divergentes COM AGENTE LEAD-FACING ATIVO (marca reunião errada AGORA): ${comAgenteAtivo.length}`);
  for (const d of comAgenteAtivo) console.log(d);
  console.log(`  ⚪ sem acesso ao Spark Leads: ${semAcesso}`);

  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
