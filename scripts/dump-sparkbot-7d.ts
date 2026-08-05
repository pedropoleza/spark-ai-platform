/**
 * One-off (Pedro 2026-06-24): dump das conversas do SparkBot dos últimos 7 dias
 * pra análise de uso + humanização. Gera transcripts legíveis por rep
 * (role/hora/canal/tools/conteúdo) + um índice de volume. Saída em
 * _planning/sparkbot-humanizacao-2026-06/data/.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/dump-sparkbot-7d.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { writeFileSync } from "fs";
import { createAdminClient } from "../src/lib/supabase/admin";

const OUT_DIR = resolve(__dirname, "..", "_planning", "sparkbot-humanizacao-2026-06", "data");

interface Row {
  rep_id: string;
  role: string;
  channel: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

async function main() {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // reps com nome
  const { data: reps } = await supabase
    .from("rep_identities")
    .select("id, display_name, phone, is_internal, active_location_id");
  const repMap = new Map<string, { name: string; phone: string; internal: boolean }>();
  for (const r of reps || []) {
    repMap.set(r.id, { name: r.display_name || "(sem nome)", phone: r.phone || "?", internal: !!r.is_internal });
  }

  // paginação das mensagens (Supabase cap 1000/req)
  const all: Row[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("sparkbot_messages")
      .select("rep_id, role, channel, content, metadata, created_at")
      .gte("created_at", since)
      .order("rep_id", { ascending: true })
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`total mensagens 7d: ${all.length}`);

  // agrupa por rep
  const byRep = new Map<string, Row[]>();
  for (const m of all) {
    if (!byRep.has(m.rep_id)) byRep.set(m.rep_id, []);
    byRep.get(m.rep_id)!.push(m);
  }

  // ordena reps por volume desc
  const repsSorted = [...byRep.entries()].sort((a, b) => b[1].length - a[1].length);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("pt-BR", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" });

  // 1 arquivo grande com todos os transcripts (chunked se precisar)
  const lines: string[] = [];
  lines.push(`# TRANSCRIPTS SPARKBOT — últimos 7 dias (gerado ${new Date().toISOString()})`);
  lines.push(`# ${all.length} mensagens · ${repsSorted.length} reps · fuso de exibição America/New_York`);
  lines.push(`# Formato: [hora] ROLE (canal) {tools} :: conteúdo\n`);

  for (const [repId, msgs] of repsSorted) {
    const info = repMap.get(repId) || { name: "(desconhecido)", phone: "?", internal: false };
    lines.push(`\n${"=".repeat(80)}`);
    lines.push(`## REP: ${info.name} (${info.phone})${info.internal ? " [INTERNO]" : ""} — ${msgs.length} msgs — id=${repId}`);
    lines.push("=".repeat(80));
    for (const m of msgs) {
      const tools = Array.isArray(m.metadata?.tools) && (m.metadata!.tools as unknown[]).length
        ? ` {${(m.metadata!.tools as string[]).join(",")}}`
        : "";
      const src = m.metadata?.source ? ` <${m.metadata.source}>` : "";
      const content = (m.content || "").replace(/\s+/g, " ").trim() || "[vazio]";
      lines.push(`[${fmt(m.created_at)}] ${m.role.toUpperCase()} (${m.channel || "?"})${tools}${src} :: ${content}`);
    }
  }

  const transcriptPath = resolve(OUT_DIR, "transcripts-7d.txt");
  writeFileSync(transcriptPath, lines.join("\n"), "utf8");
  console.log(`→ ${transcriptPath} (${(lines.join("\n").length / 1024).toFixed(0)} KB)`);

  // índice de reps
  const idx: string[] = ["# ÍNDICE DE REPS (7d) — volume + internos\n"];
  for (const [repId, msgs] of repsSorted) {
    const info = repMap.get(repId) || { name: "(desconhecido)", phone: "?", internal: false };
    const userMsgs = msgs.filter((m) => m.role === "user").length;
    const agentMsgs = msgs.filter((m) => m.role === "agent").length;
    idx.push(`- ${info.name} (${info.phone})${info.internal ? " [INTERNO]" : ""}: ${msgs.length} total (${userMsgs} user / ${agentMsgs} agent) — id=${repId}`);
  }
  const idxPath = resolve(OUT_DIR, "rep-index.txt");
  writeFileSync(idxPath, idx.join("\n"), "utf8");
  console.log(`→ ${idxPath}`);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
