/**
 * ⚠️ NÃO RE-RODAR sem antes adicionar CAP POR REP + ANTI-CLUSTER.
 * Pedro 2026-05-21: a 1ª aplicação revelou que um rep tinha 82 tasks de MESMO
 * prazo → 82 lembretes no mesmo instante (3h45 da manhã). Foi tudo CANCELADO e
 * Pedro decidiu NÃO re-rodar o backfill (fica só event-driven). Pra reativar com
 * segurança: 1 lembrete por (rep, horário) + teto por rep + quiet-hours.
 *
 * Backfill 1× dos lembretes de tarefa (FORGE-3 2026-05-21).
 *
 * O webhook só cobre tasks NOVAS/editadas. Este script varre as ANTIGAS
 * (pendentes, com prazo futuro dentro do horizonte) por location e agenda os
 * lembretes via scheduleTaskReminder (que faz dedup + resolve rep por assignedTo
 * + checa pref + pula prazo passado). DRY-RUN por padrão.
 *
 * Rodar:
 *   DRY:    npx tsx -r tsconfig-paths/register scripts/backfill-task-reminders.ts
 *   APLICA: APPLY=1 npx tsx -r tsconfig-paths/register scripts/backfill-task-reminders.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { searchLocationTasks } from "@/lib/ghl/operations";
import { scheduleTaskReminder, type TaskEvent } from "@/lib/account-assistant/proactive/task-reminders";

const APPLY = /^(1|true|yes)$/i.test(process.env.APPLY?.trim() || "");
const HORIZON_DAYS = 90;
const PAGE = 100;
const MAX_PAGES = 10; // cap defensivo: 1000 tasks/location

async function main() {
  const sb = createAdminClient();

  // Locations com rep (+ company_id pro GHLClient).
  const { data: reps } = await sb
    .from("rep_identities")
    .select("active_location_id")
    .not("active_location_id", "is", null);
  const locIds = Array.from(
    new Set((reps || []).map((r) => r.active_location_id).filter(Boolean)),
  ) as string[];
  const { data: locs } = await sb
    .from("locations")
    .select("location_id, company_id, location_name")
    .in("location_id", locIds.length ? locIds : ["__none__"]);
  const locMap = new Map((locs || []).map((l) => [l.location_id, l]));

  // Reps ATIVOS no SparkBot (Pedro 2026-05-21): T&C aceito + não rejeitado +
  // atividade real (≥1 inbound). Só esses recebem o backfill — pelos ghl_user_ids.
  const { data: activeReps } = await sb
    .from("rep_identities")
    .select("ghl_users")
    .not("terms_accepted_at", "is", null)
    .is("terms_rejected_at", null)
    .not("last_inbound_at", "is", null);
  const activeGhlUserIds = new Set<string>();
  for (const r of activeReps || []) {
    for (const u of ((r.ghl_users as Array<{ ghl_user_id?: string }> | null) || [])) {
      if (u.ghl_user_id) activeGhlUserIds.add(u.ghl_user_id);
    }
  }

  console.log(
    `[backfill] modo=${APPLY ? "APPLY (agenda)" : "DRY-RUN (só conta)"} · ${locIds.length} locations · ` +
      `horizonte ${HORIZON_DAYS}d · reps ativos=${activeReps?.length ?? 0} (ghl_users=${activeGhlUserIds.size})`,
  );

  const now = Date.now();
  const horizonMs = now + HORIZON_DAYS * 24 * 60 * 60 * 1000;
  let eligible = 0,
    scheduled = 0,
    skippedPast = 0,
    noAssignee = 0,
    nonActive = 0,
    noDue = 0,
    errors = 0;

  for (const locationId of locIds) {
    const loc = locMap.get(locationId);
    if (!loc?.company_id) {
      console.log(`  [skip] ${locationId} sem company_id`);
      continue;
    }
    const client = new GHLClient(loc.company_id, locationId);
    let skip = 0,
      page = 0,
      locFound = 0,
      locEligible = 0;
    try {
      while (page < MAX_PAGES) {
        const res = await searchLocationTasks(client, locationId, { completed: false, limit: PAGE, skip });
        const tasks = res.tasks || [];
        if (tasks.length === 0) break;
        locFound += tasks.length;
        for (const t of tasks) {
          if (t.completed) continue;
          if (!t.dueDate) {
            noDue++;
            continue;
          }
          const dueMs = Date.parse(t.dueDate);
          if (!Number.isFinite(dueMs) || dueMs <= now) {
            skippedPast++;
            continue;
          }
          if (dueMs > horizonMs) continue; // muito longe — fora do backfill
          if (!t.assignedTo) {
            noAssignee++;
            continue;
          }
          // Só reps ativos no SparkBot (T&C + atividade).
          if (!activeGhlUserIds.has(t.assignedTo)) {
            nonActive++;
            continue;
          }
          const taskId = t._id || t.id; // a busca usa _id
          if (!taskId) {
            noDue++; // sem id não dá pra agendar/dedup
            continue;
          }
          locEligible++;
          eligible++;
          if (APPLY) {
            const ev: TaskEvent = {
              ghlTaskId: taskId,
              title: t.title ?? null,
              dueAt: t.dueDate,
              assignedTo: t.assignedTo ?? null,
              contactId: t.contactId ?? null,
              locationId,
            };
            // scheduleTaskReminder faz rep-resolve + pref + dedup + skip-past preciso.
            await scheduleTaskReminder(ev);
            scheduled++;
          }
        }
        if (tasks.length < PAGE) break;
        skip += PAGE;
        page++;
      }
      console.log(
        `  [${loc.location_name || locationId}] pendentes=${locFound} elegiveis=${locEligible}`,
      );
    } catch (err) {
      errors++;
      console.error(`  [ERRO] location ${locationId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(
    `\n[backfill] RESUMO: elegiveis(reps ativos)=${eligible} · agendadas=${APPLY ? scheduled : "(dry-run)"} ` +
      `· pulou_passado/invalido=${skippedPast} · sem_assignee=${noAssignee} · assignee_nao_ativo=${nonActive} · sem_due=${noDue} · erros_location=${errors}`,
  );
  if (!APPLY) console.log("[backfill] DRY-RUN — nada agendado. Rode com APPLY=1 pra agendar de verdade.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
