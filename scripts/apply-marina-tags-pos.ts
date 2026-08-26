/**
 * Cria as 2 tags do fluxo de pós-atendimento na PERSONAL account da Marina
 * (ONRf1DUKVnfxivEGxcTj) — transferência 2026-08-25.
 *
 *   enviar-pos-atendimento → a equipe aplica; DISPARA o workflow
 *   pos-atendimento-ia     → o workflow aplica; LIGA a IA pro contato (gate)
 *
 * Idempotente: se a tag já existe (mesmo nome, case-insensitive), NÃO cria de
 * novo — tag duplicada = gatilho morto (lição Jussara 23/08).
 *   npx tsx scripts/apply-marina-tags-pos.ts [--dry]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "ONRf1DUKVnfxivEGxcTj";
const TAGS = ["enviar-pos-atendimento", "pos-atendimento-ia", "registro-confirmado-ia"];
const DRY = process.argv.includes("--dry");

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  if (!loc) throw new Error("location não cadastrada");
  const c = new GHLClient(loc.company_id, LOC);

  const r = await c.get<{ tags?: { id: string; name: string }[] }>(`/locations/${LOC}/tags`);
  const existentes = new Map((r.tags || []).map((t) => [t.name.toLowerCase().trim(), t]));
  console.log(`tags na conta: ${existentes.size}`);

  for (const nome of TAGS) {
    const ja = existentes.get(nome);
    if (ja) {
      console.log(`✓ já existe: ${nome} (${ja.id}) — não recriado`);
      continue;
    }
    if (DRY) {
      console.log(`[dry] criaria: ${nome}`);
      continue;
    }
    try {
      const res = await c.post<{ tag?: { id: string; name: string } }>(`/locations/${LOC}/tags`, { name: nome });
      console.log(`＋ criada: ${res.tag?.name ?? nome} (${res.tag?.id ?? "?"})`);
    } catch (e) {
      console.error(`✗ falhou criar ${nome}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
    }
  }

  const conf = await c.get<{ tags?: { name: string }[] }>(`/locations/${LOC}/tags`);
  const nomes = (conf.tags || []).map((t) => t.name.toLowerCase().trim());
  console.log("\n=== CONFERÊNCIA ===");
  for (const nome of TAGS) {
    const n = nomes.filter((x) => x === nome).length;
    console.log(`${n === 1 ? "✅" : n === 0 ? "❌ AUSENTE" : `❌ DUPLICADA ×${n}`}  ${nome}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
