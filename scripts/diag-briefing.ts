/**
 * Diagnóstico do Resumo matinal de UM rep: mostra exatamente o que o briefing
 * enxerga hoje e se ele seria enviado ou descartado.
 *
 * Nasceu do caso Natalia (2026-08-05): ela pedia os compromissos do dia e
 * recebia uma frase genérica. Ninguém conseguia ver POR QUE sem rodar o cron.
 * Aqui dá pra ver a resposta em uma tela: reuniões do Spark Leads, compromissos
 * do Google, e o veredito (enviaria / skipped_empty).
 *
 *   npx tsx scripts/diag-briefing.ts +15614517893
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const TELEFONE = process.argv[2];

async function main() {
  if (!TELEFONE) {
    console.error("uso: npx tsx scripts/diag-briefing.ts +1XXXXXXXXXX");
    process.exit(1);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const { loadDailyContext } = await import(
    "../src/lib/account-assistant/proactive/daily-briefing"
  );
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const digitos = TELEFONE.replace(/\D/g, "");
  const { data: reps } = await db
    .from("rep_identities")
    .select("*")
    .like("phone", `%${digitos}%`);
  if (!reps?.length) {
    console.error(`nenhum rep com telefone ~${digitos}`);
    process.exit(1);
  }

  for (const rep of reps) {
    console.log(`\n═══ ${rep.display_name} (${rep.phone}) · ${rep.timezone || "sem fuso próprio"}`);
    if (rep.daily_briefing_enabled === false) {
      console.log("  ⚠️  briefing DESLIGADO por opt-out do rep (set_daily_briefing)");
    }
    const t0 = Date.now();
    const ctx = await loadDailyContext(rep);
    const ms = Date.now() - t0;

    if (!ctx) {
      console.log(`  🔴 loadDailyContext devolveu NULL em ${ms}ms → o cron marca skipped_empty`);
      console.log("     (nenhuma reunião no Spark Leads, nenhum compromisso do Google, nada de ontem)");
      continue;
    }

    console.log(`  ✅ briefing SERIA ENVIADO — ${ctx.date_label} · ${ms}ms pra montar`);
    console.log(`\n  📅 Reuniões do Spark Leads (${ctx.appointments_today.length}):`);
    for (const a of ctx.appointments_today) {
      console.log(`     • ${a.start_time_label} — ${a.contact_name}${a.calendar_name ? ` (${a.calendar_name})` : ""}`);
    }
    if (!ctx.appointments_today.length) console.log("     (nenhuma)");

    console.log(`\n  🔒 Compromissos fora do CRM (${ctx.blocks_today.length}${ctx.blocks_truncated_count ? ` +${ctx.blocks_truncated_count} truncados` : ""}):`);
    for (const b of ctx.blocks_today) {
      console.log(`     • ${b.start_time_label}–${b.end_time_label} — ${b.title}  [${b.source}]`);
    }
    if (!ctx.blocks_today.length) console.log("     (nenhum)");

    const y = ctx.yesterday;
    console.log(`\n  📊 Ontem: ${y.deals_closed.length} deal(s), ${y.notes_created} nota(s), ${y.tasks_completed}/${y.tasks_total} task(s)`);

    // O ponto do fix de 05/08: com só compromisso do Google, o briefing
    // costumava ser descartado.
    if (!ctx.appointments_today.length && ctx.blocks_today.length > 0) {
      console.log("\n  👉 Dia SÓ com compromisso do Google — antes do fix isso virava skipped_empty.");
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
