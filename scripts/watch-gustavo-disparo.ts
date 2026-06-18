/**
 * Watcher temporário do disparo do Gustavo (caso travado 2026-06-15).
 * Acompanha os 2 jobs até pending+sending zerar (ou ~7min), 1 linha por poll.
 *   npx tsx -r tsconfig-paths/register scripts/watch-gustavo-disparo.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const JOBS = [
  ["M1", "be32b580-5c1f-4434-b482-a1c3ade7b30f"],
  ["M0+Prova", "e8c885b3-2482-484d-8173-4403ce13ef0a"],
] as const;

async function snapshot(supabase: ReturnType<typeof createAdminClient>) {
  const lines: string[] = [];
  let allDone = true;
  let anyFail = 0;
  for (const [label, jobId] of JOBS) {
    const { data } = await supabase
      .from("bulk_message_recipients")
      .select("status")
      .eq("job_id", jobId);
    const c: Record<string, number> = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of (data || []) as Array<{ status: string }>) if (c[r.status] !== undefined) c[r.status]++;
    const total = c.pending + c.sending + c.sent + c.failed + c.skipped;
    if (c.pending > 0 || c.sending > 0) allDone = false;
    anyFail += c.failed;
    lines.push(`${label}: ${c.sent}/${total} enviados (pend ${c.pending}, send ${c.sending}, fail ${c.failed}, skip ${c.skipped})`);
  }
  return { line: lines.join("  |  "), allDone, anyFail };
}

async function main() {
  const supabase = createAdminClient();
  const MAX = 28; // ~7 min a 15s
  for (let i = 0; i < MAX; i++) {
    const { line, allDone, anyFail } = await snapshot(supabase);
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${line}`);
    if (allDone) {
      console.log(`✅ DISPARO COMPLETO — ambos os jobs zeraram a fila${anyFail ? ` (com ${anyFail} falha(s) — checar)` : ", zero falhas"}.`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log("⏱️ timeout do watcher (ainda drenando — rodar de novo se preciso).");
  process.exit(0);
}
main().catch((e) => { console.error("watcher erro:", e instanceof Error ? e.message : e); process.exit(1); });
