/**
 * Religa o agente lead-facing da Jussara (par do `pause-jussara-agora.ts`).
 *
 * Contexto: o agente foi pra `inactive` em 2026-08-23T22:11:45Z e a conta ficou
 * MUDA pra lead desde então (o webhook descarta o inbound antes de enfileirar
 * quando não há agente ativo — nem fila, nem execution_log, nem sinal).
 * Diagnóstico completo: `_planning/jussara-sparkbot/DEFEITOS-2026-08-19.md`.
 *
 * Dry-run por padrão. Só escreve com --apply.
 *   npx tsx scripts/religa-jussara.ts            # mostra o que faria
 *   npx tsx scripts/religa-jussara.ts --apply    # religa
 *
 * PRÉ-CHECK (o mesmo de 20/08): recusa religar se o gate-ponte não estiver no
 * banco. Sem as regras de targeting, `null` = "responde a todos" — e foi
 * exatamente isso que fez a IA atender cliente/colega/grupo em 19/08.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const AGENT = "a297dadc-873a-4803-885d-472c65414168";
const LOC = "pGl5pqLLG0QDixANpFnP";
const APPLY = process.argv.includes("--apply");

async function main() {
  const sb = createAdminClient();

  const { data: ag } = await sb.from("agents").select("name,status,updated_at").eq("id", AGENT).single();
  console.log(`agente : ${ag?.name}`);
  console.log(`status : ${ag?.status}  (desde ${ag?.updated_at})`);

  if (ag?.status === "active") {
    console.log("\n✅ Já está ativo — nada a fazer.");
    return;
  }

  // --- PRÉ-CHECK do gate ---
  const { data: cfg } = await sb.from("agent_configs").select("targeting_rules, enabled_channels").eq("agent_id", AGENT).single();
  const rules = cfg?.targeting_rules as { groups?: Array<{ rules?: unknown[] }> } | null;
  const nFolhas = (rules?.groups || []).reduce((s, g) => s + (g.rules?.length || 0), 0);

  console.log(`canais : ${JSON.stringify(cfg?.enabled_channels)}`);
  console.log(`gate   : ${nFolhas} folha(s) de targeting`);

  if (!rules || nFolhas === 0) {
    console.error(
      "\n❌ ABORTADO: targeting_rules vazio/nulo = 'responde a todos'.\n" +
      "   Nesta conta isso significa atender cliente, colega, grupo e contato de\n" +
      "   emergência — foi o incidente de 19/08. Reaplique o gate-ponte antes\n" +
      "   (scripts/apply-jussara-gate-agendamento.ts) e rode de novo."
    );
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\n[dry-run] religaria agora: agents.status = 'active'");
    console.log("          rode de novo com --apply pra valer.");
    console.log("\nObs: religar NÃO responde o passivo — a fila está vazia (o webhook");
    console.log("     descartou tudo). Só mensagens NOVAS a partir de agora entram.");
    return;
  }

  const { error } = await sb.from("agents").update({ status: "active" }).eq("id", AGENT);
  if (error) throw new Error(error.message);

  const { data: depois } = await sb.from("agents").select("status,updated_at").eq("id", AGENT).single();
  console.log(`\n✅ RELIGADO: status=${depois?.status} (${depois?.updated_at})`);
  console.log(`\nMonitor de 30min: bash scripts/_watch-jussara-religa.sh`);
  console.log(`Critério de reversão (19/08): 1 send pra não-lead → pausa e revisão.`);
  console.log(`   npx tsx scripts/pause-jussara-agora.ts`);

  const { count } = await sb
    .from("conversation_state")
    .select("id", { count: "exact", head: true })
    .eq("location_id", LOC)
    .not("ai_paused_at", "is", null);
  console.log(`\nℹ️  ${count ?? "?"} conversas seguem pausadas individualmente (F52/post_booking) —`);
  console.log(`   religar o agente não desfaz essas; é a aba "Pausadas" do painel.`);
}

main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
