/**
 * Check-up de saúde do SparkBot para UM rep (H68, caso Gustavo Couto).
 *
 * Nasceu porque o Gustavo — usuário pesado, 30-60 msgs/dia — ficou 12 dias sem
 * nenhum proativo e perdeu 12 lembretes sem ninguém perceber. Nenhum dos gates
 * que o bloqueou (loop-guard, wallet, silêncio) aparece pro operador: cada um
 * vive numa tabela diferente. Aqui eles ficam na mesma tela.
 *
 *   npx tsx scripts/rep-health.ts +17542650461
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const TELEFONE = process.argv[2];

function linha(rotulo: string, valor: string, alerta = false) {
  console.log(`  ${alerta ? "🔴" : "✅"} ${rotulo.padEnd(30)} ${valor}`);
}

async function main() {
  if (!TELEFONE) {
    console.error("uso: npx tsx scripts/rep-health.ts +1XXXXXXXXXX");
    process.exit(1);
  }
  const { createClient } = await import("@supabase/supabase-js");
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

  for (const rep of reps as Array<Record<string, unknown>>) {
    const id = String(rep.id);
    console.log(`\n═══ ${rep.display_name} (${rep.phone}) · location ${rep.active_location_id}`);

    // 1. Pausa de proativos — o que segurou o Gustavo por 12 dias
    const pausado = !!rep.proactive_paused_at;
    linha(
      "proativos",
      pausado
        ? `PAUSADO desde ${String(rep.proactive_paused_at).slice(0, 16)} (origem: ${rep.proactive_pause_source || "silêncio"})`
        : "liberados",
      pausado,
    );
    linha("silêncio consecutivo", String(rep.consecutive_proactive_without_reply ?? 0),
      Number(rep.consecutive_proactive_without_reply ?? 0) >= 3);
    linha("fuso cadastrado", String(rep.timezone || "— (cai no da location)"), !rep.timezone);
    linha("termos aceitos", rep.terms_accepted_at ? "sim" : "NÃO — bot não fala com ele", !rep.terms_accepted_at);

    // 2. Entrega dos últimos proativos
    const { data: proativos } = await db
      .from("sparkbot_messages")
      .select("created_at, metadata")
      .eq("rep_id", id)
      .eq("role", "agent")
      .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
      .order("created_at", { ascending: false })
      .limit(200);
    const procs = (proativos || []).filter((m) => {
      const s = (m as { metadata?: Record<string, unknown> }).metadata?.source;
      return s === "proactive_rule" || s === "scheduled_reminder" || s === "task_reminder";
    });
    const naoEntregues = procs.filter(
      (m) => (m as { metadata?: Record<string, unknown> }).metadata?.not_sent === true,
    ).length;
    linha(
      "proativos 7d",
      `${procs.length} gerados · ${procs.length - naoEntregues} entregues · ${naoEntregues} falharam`,
      naoEntregues > 0,
    );

    // 3. Lembretes: pendentes, e os que sumiram sem gerar mensagem
    const { data: tasks } = await db
      .from("assistant_scheduled_tasks")
      .select("id, status, next_run_at, last_run_at, task_payload, task_type")
      .eq("rep_id", id)
      .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
    const lista = (tasks || []) as Array<Record<string, unknown>>;
    const pendentes = lista.filter((t) => t.status === "pending");
    linha("lembretes pendentes", String(pendentes.length));

    const concluidos = lista.filter((t) => t.status === "completed" && t.last_run_at);
    let fantasmas = 0;
    const titulosFantasma: string[] = [];
    for (const t of concluidos) {
      // A auditoria usa chave diferente por tipo: lembrete pro REP grava
      // `reminder_id`; mensagem agendada pro CONTATO grava `scheduled_task_id`.
      // Checar só uma das duas dava falso-positivo (contava como sumida uma
      // mensagem que saiu pro cliente normalmente).
      const [{ count: c1 }, { count: c2 }] = await Promise.all([
        db.from("sparkbot_messages").select("id", { count: "exact", head: true })
          .eq("metadata->>reminder_id", String(t.id)),
        db.from("sparkbot_messages").select("id", { count: "exact", head: true })
          .eq("metadata->>scheduled_task_id", String(t.id)),
      ]);
      if (!c1 && !c2) {
        fantasmas++;
        const p = (t.task_payload || {}) as Record<string, unknown>;
        titulosFantasma.push(`${String(t.last_run_at).slice(0, 10)} [${String(t.task_type).replace("outbound_to_contact", "msg p/ contato").replace("reminder", "lembrete")}] ${String(p.title || p.message || "?").slice(0, 44)}`);
      }
    }
    linha(
      "lembretes que sumiram",
      fantasmas === 0 ? "nenhum" : `${fantasmas} disparados sem gerar mensagem`,
      fantasmas > 0,
    );
    if (titulosFantasma.length) {
      for (const t of titulosFantasma) console.log(`       · ${t}`);
    }

    // 4. Wallet da location
    const { data: sinais } = await db
      .from("admin_signals")
      .select("title, last_seen_at")
      .ilike("metadata", `%${rep.active_location_id}%`)
      .order("last_seen_at", { ascending: false })
      .limit(3);
    if (sinais?.length) {
      console.log("  ── sinais recentes da location:");
      for (const s of sinais as Array<Record<string, unknown>>) {
        console.log(`       · ${String(s.last_seen_at).slice(0, 16)} ${String(s.title).slice(0, 70)}`);
      }
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
