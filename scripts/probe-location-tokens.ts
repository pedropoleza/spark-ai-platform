// Probe de acesso de tokens por location.
// Roda com: npx tsx -r tsconfig-paths/register scripts/probe-location-tokens.ts
//
// Pra cada location no DB, tenta gerar location token via API GHL.
// Reporta quais falham (401/403/404) com motivo.

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { getLocationToken, invalidateTokenCache } from "@/lib/ghl/auth";

const CONCURRENCY = 10; // 10 paralelos pra não estourar rate limit GHL

interface ProbeResult {
  location_id: string;
  company_id: string;
  has_active_rep: boolean;
  has_active_agent: boolean;
  status: "ok" | "fail";
  error?: string;
  duration_ms: number;
}

async function probeOne(loc: {
  location_id: string;
  company_id: string;
  has_active_rep: boolean;
  has_active_agent: boolean;
}): Promise<ProbeResult> {
  const t0 = Date.now();
  // Invalida cache pra forçar request real
  invalidateTokenCache(loc.company_id, loc.location_id);
  try {
    await getLocationToken(loc.company_id, loc.location_id);
    return { ...loc, status: "ok", duration_ms: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...loc, status: "fail", error: msg.slice(0, 200), duration_ms: Date.now() - t0 };
  }
}

async function main() {
  const supa = createAdminClient();
  const { data } = await supa
    .from("locations")
    .select("location_id, company_id, location_name")
    .neq("location_id", "x")
    .neq("location_id", "test");
  if (!data) {
    console.error("Sem locations no DB");
    process.exit(1);
  }

  // Hidrata active_rep e active_agent
  const enriched = await Promise.all(
    data.map(async (l) => {
      const [reps, agents] = await Promise.all([
        supa.from("rep_identities").select("id", { count: "exact", head: true }).eq("active_location_id", l.location_id),
        supa.from("agents").select("id", { count: "exact", head: true }).eq("location_id", l.location_id).eq("type", "account_assistant").eq("status", "active"),
      ]);
      return {
        location_id: l.location_id,
        company_id: l.company_id,
        location_name: l.location_name,
        has_active_rep: (reps.count ?? 0) > 0,
        has_active_agent: (agents.count ?? 0) > 0,
      };
    })
  );

  console.log(`\n=== Probing ${enriched.length} locations (concurrency=${CONCURRENCY}) ===\n`);

  const results: ProbeResult[] = [];
  for (let i = 0; i < enriched.length; i += CONCURRENCY) {
    const chunk = enriched.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(probeOne));
    results.push(...chunkResults);
    process.stdout.write(`  ${i + chunk.length}/${enriched.length}\r`);
  }
  console.log("");

  const ok = results.filter((r) => r.status === "ok");
  const fail = results.filter((r) => r.status === "fail");

  console.log(`\n================================================================`);
  console.log(`✅ OK: ${ok.length}/${results.length}`);
  console.log(`❌ FAIL: ${fail.length}/${results.length}`);
  console.log(`================================================================\n`);

  if (fail.length > 0) {
    console.log("LOCATIONS SEM ACESSO A TOKEN:\n");
    // Agrupa por motivo do erro
    const byError = new Map<string, ProbeResult[]>();
    for (const r of fail) {
      const key = (r.error || "").includes("401")
        ? "401 unauthorized"
        : (r.error || "").includes("403")
          ? "403 forbidden (sem acesso à location)"
          : (r.error || "").includes("404")
            ? "404 not found"
            : (r.error || "").includes("companyId")
              ? "company token ausente"
              : "outros";
      const list = byError.get(key) || [];
      list.push(r);
      byError.set(key, list);
    }

    for (const [errorType, locs] of byError.entries()) {
      console.log(`\n--- ${errorType} (${locs.length}) ---`);
      // Order: active first
      const sorted = locs.sort((a, b) => {
        const aScore = (a.has_active_rep ? 2 : 0) + (a.has_active_agent ? 1 : 0);
        const bScore = (b.has_active_rep ? 2 : 0) + (b.has_active_agent ? 1 : 0);
        return bScore - aScore;
      });
      for (const r of sorted) {
        const badges: string[] = [];
        if (r.has_active_rep) badges.push("👤active_rep");
        if (r.has_active_agent) badges.push("🤖active_agent");
        console.log(`  ${r.location_id}  ${badges.join(" ") || "(idle)"}`);
      }
    }

    console.log("\nLista pura (copia&cola pra reinstalar):");
    for (const r of fail) {
      console.log(r.location_id);
    }
  }
}

main().catch((err) => {
  console.error("Probe falhou:", err);
  process.exit(1);
});
