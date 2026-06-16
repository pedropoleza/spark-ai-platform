/**
 * check-migration-drift — trava anti-drift de migration (Pedro 2026-06-15).
 *
 * POR QUE EXISTE: migrations são aplicadas À MÃO via MCP. Em 2026-06-10 um lote
 * inteiro (00100–00106) ficou no repo mas NÃO foi aplicado em prod → a RPC
 * claim_bulk_recipients e colunas claim_token/claimed_at não existiam → o bulk-
 * runner travava em silêncio (claim retornava 0, heartbeat mascarava). A auditoria
 * achou +3 drifts históricos (media_library, conversation_state.triggered_automations,
 * idx_message_queue_ghl_dedup) que passaram MESES despercebidos.
 *
 * O QUE FAZ: parseia o DDL de TODAS as supabase/migrations/*.sql, extrai os objetos
 * persistentes que cada uma declara (tabela, coluna via ALTER ADD, índice, função,
 * cron job, trigger), aplica os DROPs posteriores, e compara com a EXISTÊNCIA REAL
 * em prod (RPC public.schema_object_inventory, migration 00108) — NUNCA com
 * supabase_migrations.schema_migrations (bookkeeping manual que foi exatamente o
 * que falhou). Drift = declarado nos arquivos mas AUSENTE em prod, menos o allowlist.
 *
 * USO:
 *   npx tsx -r tsconfig-paths/register scripts/check-migration-drift.ts
 * Exit 0 = limpo. Exit 1 = drift não-allowlisted (falha o build / dispara signal).
 *
 * LIMITAÇÕES CONHECIredidas (residual_risk do review): só checa EXISTÊNCIA, não
 * equivalência semântica do corpo (função/cron com mesmo nome mas corpo velho passa
 * — ex: a 00104 em hold). Colunas só são rastreadas via ALTER TABLE ADD COLUMN, não
 * via colunas inline de CREATE TABLE (a tabela existindo já cobre as inline).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { readFileSync, readdirSync, existsSync } from "fs";
import { createAdminClient } from "../src/lib/supabase/admin";

const MIGRATIONS_DIR = resolve(__dirname, "..", "supabase", "migrations");
const ALLOW_PATH = resolve(__dirname, "migration-drift-allow.json");

type ObjType = "table" | "column" | "index" | "function" | "cron" | "trigger";
interface Expected { type: ObjType; name: string; migration: string }

// Remove comentários SQL (-- linha e /* bloco */) pra não casar DDL comentado.
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const norm = (s: string) => s.replace(/["'`]/g, "").replace(/^public\./i, "").trim().toLowerCase();
const key = (t: ObjType, n: string) => `${t}:${norm(n)}`;

function parseMigration(file: string, raw: string, expected: Map<string, Expected>) {
  const sql = stripComments(raw);

  // ── CREATEs (regex sobre o conteúdo inteiro) ───────────────────────────────
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?(\w+)["']?/gi))
    expected.set(key("table", m[1]), { type: "table", name: norm(m[1]), migration: file });

  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi))
    expected.set(key("index", m[1]), { type: "index", name: norm(m[1]), migration: file });

  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?["']?(\w+)["']?/gi))
    expected.set(key("function", m[1]), { type: "function", name: norm(m[1]), migration: file });

  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+["']?(\w+)["']?/gi))
    expected.set(key("trigger", m[1]), { type: "trigger", name: norm(m[1]), migration: file });

  for (const m of sql.matchAll(/cron\.schedule\s*\(\s*'([^']+)'/gi))
    expected.set(key("cron", m[1]), { type: "cron", name: norm(m[1]), migration: file });

  // ── DROPs de objetos top-level → remove do expected ────────────────────────
  for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["']?(\w+)["']?/gi)) {
    expected.delete(key("table", m[1]));
    for (const k of [...expected.keys()]) if (k.startsWith(`column:${norm(m[1])}.`)) expected.delete(k);
  }
  for (const m of sql.matchAll(/DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?["']?(\w+)["']?/gi))
    expected.delete(key("index", m[1]));
  for (const m of sql.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["']?(\w+)["']?/gi))
    expected.delete(key("function", m[1]));
  for (const m of sql.matchAll(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?["']?(\w+)["']?/gi))
    expected.delete(key("trigger", m[1]));

  // ── Colunas: por statement (split ';' é seguro p/ ALTER — sem dollar-quote) ─
  for (const stmt of sql.split(";")) {
    const at = stmt.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?["']?(\w+)["']?/i);
    if (!at) continue;
    const table = norm(at[1]);
    for (const c of stmt.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi))
      expected.set(key("column", `${table}.${c[1]}`), { type: "column", name: `${table}.${norm(c[1])}`, migration: file });
    for (const c of stmt.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["']?(\w+)["']?/gi))
      expected.delete(key("column", `${table}.${c[1]}`));
  }
}

async function main() {
  // 1) Expected: parseia todas as migrations EM ORDEM (DROP posterior remove).
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const expected = new Map<string, Expected>();
  for (const f of files) parseMigration(f, readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"), expected);

  // 2) Allowlist (exceções versionadas com justificativa).
  const allow = new Set<string>();
  const allowMeta: Record<string, { reason: string; since?: string }> = {};
  if (existsSync(ALLOW_PATH)) {
    const j = JSON.parse(readFileSync(ALLOW_PATH, "utf8")) as { allow?: Array<{ type: ObjType; name: string; reason: string; since?: string }> };
    for (const a of j.allow || []) { allow.add(key(a.type, a.name)); allowMeta[key(a.type, a.name)] = { reason: a.reason, since: a.since }; }
  }

  // 3) Estado REAL de prod (RPC de inventário, migration 00108).
  const supabase = createAdminClient();
  const { data: inv, error } = await supabase.rpc("schema_object_inventory");
  if (error || !inv) {
    console.error(`❌ schema_object_inventory falhou (migration 00108 aplicada?): ${error?.message || "sem dados"}`);
    process.exit(2);
  }
  const prod: Record<ObjType, Set<string>> = {
    table: new Set((inv.tables || []).map((s: string) => norm(s))),
    column: new Set((inv.columns || []).map((s: string) => norm(s))),
    index: new Set((inv.indexes || []).map((s: string) => norm(s))),
    function: new Set((inv.functions || []).map((s: string) => norm(s))),
    cron: new Set((inv.cron_jobs || []).map((s: string) => norm(s))),
    trigger: new Set((inv.triggers || []).map((s: string) => norm(s))),
  };

  // 4) Diff: declarado mas AUSENTE em prod, menos allowlist.
  const drift: Expected[] = [];
  const allowed: Expected[] = [];
  for (const e of expected.values()) {
    if (prod[e.type].has(norm(e.name))) continue;
    if (allow.has(key(e.type, e.name))) { allowed.push(e); continue; }
    drift.push(e);
  }

  // 5) Relatório.
  const counts = (["table", "column", "index", "function", "cron", "trigger"] as ObjType[])
    .map((t) => `${t}:${[...expected.values()].filter((e) => e.type === t).length}`).join("  ");
  console.log(`\n🔎 check-migration-drift`);
  console.log(`   migrations: ${files.length}  |  objetos declarados: ${expected.size}  (${counts})`);
  console.log(`   prod: tables ${prod.table.size}, columns ${prod.column.size}, indexes ${prod.index.size}, functions ${prod.function.size}, cron ${prod.cron.size}, triggers ${prod.trigger.size}`);
  if (allowed.length) {
    console.log(`\n⚪ ${allowed.length} ausente(s) mas ALLOWLISTED (ok):`);
    for (const e of allowed) console.log(`   - [${e.type}] ${e.name}  (${e.migration})  — ${allowMeta[key(e.type, e.name)]?.reason || "?"}`);
  }
  if (drift.length === 0) {
    console.log(`\n✅ SEM DRIFT — todo objeto declarado nas migrations existe em prod.\n`);
    process.exit(0);
  }
  console.log(`\n🔴 DRIFT: ${drift.length} objeto(s) declarado(s) mas AUSENTE(s) em prod:`);
  for (const e of drift.sort((a, b) => a.migration.localeCompare(b.migration)))
    console.log(`   - [${e.type}] ${e.name}   ← ${e.migration}`);
  console.log(`\n   Aplique a(s) migration(s) acima em prod, ou adicione ao scripts/migration-drift-allow.json com justificativa.\n`);
  process.exit(1);
}

main().catch((e) => { console.error("check-migration-drift erro:", e instanceof Error ? e.message : e); process.exit(2); });
