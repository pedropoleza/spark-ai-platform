/**
 * Panorama de saúde das contas lead-facing (H92) — read-only, sob demanda.
 *
 *   npx tsx scripts/saude-contas.ts [horas]     (default 24)
 *
 * Junta as três perguntas que importam, que hoje estavam espalhadas:
 *   1. a conta responde?            (vigia de contas mudas, H89)
 *   2. responde RÁPIDO?             (latência p50/p90 — o que faltava)
 *   3. o silêncio tem explicação?   (silêncio sem motivo registrado)
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: process.env.STRESS_ENV_FILE || resolve(__dirname, "..", ".env.local") });

const horas = Number(process.argv[2] || 24);

function barra(pct: number): string {
  const n = Math.min(10, Math.round(pct / 10));
  return "█".repeat(n) + "░".repeat(10 - n);
}

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();

  const { data, error } = await sb.rpc("medir_latencia_resposta", { p_horas: horas });
  if (error) throw new Error(error.message);

  const linhas = (data || []) as Array<{
    location_id: string; location_name: string | null; amostra: number;
    p50_min: number; p90_min: number; lentas: number; pior_min: number;
    sem_resposta_sem_motivo: number;
  }>;

  console.log(`\n═══ SAÚDE DAS CONTAS · últimas ${horas}h ═══\n`);
  console.log("conta                          resp   p50    p90   >10min        sem explicação");
  console.log("─".repeat(84));

  let alerta = 0;
  for (const c of linhas.filter((l) => l.amostra > 0 || l.sem_resposta_sem_motivo > 0)) {
    const pct = c.amostra > 0 ? Math.round((1000 * c.lentas) / c.amostra) / 10 : 0;
    const ruim = pct >= 10 || c.p90_min >= 10 || c.sem_resposta_sem_motivo > 0;
    if (ruim) alerta++;
    const nome = (c.location_name || c.location_id).slice(0, 28).padEnd(30);
    console.log(
      `${ruim ? "⚠️ " : "   "}${nome}` +
      `${String(c.amostra).padStart(4)}  ` +
      `${String(c.p50_min + "m").padStart(4)}  ` +
      `${String(c.p90_min + "m").padStart(5)}  ` +
      `${barra(pct)} ${String(pct + "%").padStart(6)}  ` +
      `${c.sem_resposta_sem_motivo > 0 ? "❗ " + c.sem_resposta_sem_motivo : "—"}`,
    );
  }

  // fila parada agora
  const { data: presas } = await sb
    .from("message_queue").select("location_id, process_after")
    .eq("status", "pending").lte("process_after", new Date(Date.now() - 4 * 60_000).toISOString())
    .order("process_after", { ascending: true }).limit(50);

  console.log("\n─── fila agora ───");
  if (!presas?.length) console.log("  ✅ nada preso");
  else {
    const idade = Math.round((Date.now() - new Date(presas[0].process_after as string).getTime()) / 60_000);
    console.log(`  ⚠️  ${presas.length} mensagem(ns) vencida(s), a mais antiga há ${idade} min`);
    console.log(`     locations: ${[...new Set(presas.map((p) => p.location_id))].join(", ")}`);
  }

  // órfãs reapadas (assinatura de lambda morta no meio do lote)
  const { data: orfas } = await sb
    .from("execution_log").select("created_at, action_payload")
    .eq("action_type", "queue_orphans_reaped")
    .gte("created_at", new Date(Date.now() - horas * 3600_000).toISOString())
    .order("created_at", { ascending: false }).limit(5);
  console.log("\n─── lambda morrendo no meio do lote (órfãs) ───");
  if (!orfas?.length) console.log("  ✅ nenhuma ocorrência na janela");
  else for (const o of orfas) {
    console.log(`  ⚠️  ${o.created_at} — ${(o.action_payload as { count?: number })?.count} órfã(s)`);
  }

  console.log(`\n${alerta === 0 ? "✅ todas as contas saudáveis" : `⚠️  ${alerta} conta(s) merecendo olhada`}\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
