/**
 * Dump rápido da conversa recente do Sparkbot (debug Agendamento V2).
 * Uso: npx tsx -r tsconfig-paths/register scripts/peek-convo.ts [horas]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const hours = parseFloat(process.argv[2] || "3");
  const supabase = createAdminClient();
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("sparkbot_messages")
    .select("created_at, rep_id, role, channel, content, metadata")
    .gt("created_at", since)
    .order("created_at", { ascending: true })
    .limit(120);

  if (error) {
    console.error("ERRO:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log(`(nenhuma msg nas últimas ${hours}h)`);
    return;
  }

  // Resolve nomes dos reps
  const repIds = [...new Set(data.map((m) => m.rep_id))];
  const { data: reps } = await supabase
    .from("rep_identities")
    .select("id, display_name, phone")
    .in("id", repIds);
  const repName = new Map((reps || []).map((r) => [r.id, r.display_name || r.phone || r.id.slice(0, 6)]));

  console.log(`=== ${data.length} msgs nas últimas ${hours}h ===\n`);
  for (const m of data) {
    const t = new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const who = m.role === "user" ? `👤 ${repName.get(m.rep_id)}` : "🤖 bot";
    const ch = m.channel ? `[${m.channel}]` : "";
    console.log(`──── ${t} ${who} ${ch}`);
    const content = (m.content || "").replace(/\n/g, "\n     ");
    console.log(`     ${content.slice(0, 700)}`);

    // tool_calls
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const tcs = meta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(tcs) && tcs.length > 0) {
      for (const tc of tcs) {
        const name = tc.name || tc.tool || "?";
        const args = tc.args || tc.arguments || tc.input;
        const res = tc.result as Record<string, unknown> | undefined;
        const status = res?.status || tc.status || "?";
        const argStr = args ? JSON.stringify(args).slice(0, 220) : "";
        console.log(`        🔧 ${name} → ${status}  ${argStr}`);
        if (res && (res.status === "error" || res.message)) {
          console.log(`           ↳ ${String(res.message || "").slice(0, 200)}`);
        }
      }
    }
    // interactive payload?
    if (meta.interactive) {
      console.log(`        💬 interactive: ${JSON.stringify(meta.interactive).slice(0, 300)}`);
    }
  }
}

main().then(() => process.exit(0));
