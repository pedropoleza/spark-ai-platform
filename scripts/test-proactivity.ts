/**
 * Teste unit do resolver de preferências de proatividade (FORGE-3 2026-05-21).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-proactivity.ts
 */
import {
  resolveProactivityPref,
  taskReminderLeadMin,
  PROACTIVITY_DEFAULTS,
} from "@/lib/account-assistant/proactive/preferences";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

type Rep = Parameters<typeof resolveProactivityPref>[0];
const rep = (p: Partial<Rep>): Rep => ({ proactivity_prefs: undefined, daily_briefing_enabled: undefined, ...p });

// Defaults da matriz (úteis ON, nicho OFF)
check("task_reminder default ON", resolveProactivityPref(rep({}), "task_reminder").enabled === true);
check("task_reminder lead_min default 15", taskReminderLeadMin(rep({})) === 15);
check("post_meeting default ON", resolveProactivityPref(rep({}), "post_meeting").enabled === true);
check("pre_meeting_briefing default ON", resolveProactivityPref(rep({}), "pre_meeting_briefing").enabled === true);
check("deal_won default OFF", resolveProactivityPref(rep({}), "deal_won").enabled === false);
check("task_overdue default OFF", resolveProactivityPref(rep({}), "task_overdue").enabled === false);
check("opportunity_stale default OFF", resolveProactivityPref(rep({}), "opportunity_stale").enabled === false);

// Override por rep
check(
  "task_reminder override OFF",
  resolveProactivityPref(rep({ proactivity_prefs: { task_reminder: { enabled: false } } }), "task_reminder").enabled === false,
);
check(
  "deal_won override ON",
  resolveProactivityPref(rep({ proactivity_prefs: { deal_won: { enabled: true } } }), "deal_won").enabled === true,
);
check(
  "task_reminder lead_min override 30",
  taskReminderLeadMin(rep({ proactivity_prefs: { task_reminder: { enabled: true, params: { lead_min: 30 } } } })) === 30,
);
check(
  "lead_min inválido (0) cai pro default 15",
  taskReminderLeadMin(rep({ proactivity_prefs: { task_reminder: { params: { lead_min: 0 } } } })) === 15,
);

// daily_briefing usa a coluna legada
check("daily_briefing default ON (sem coluna)", resolveProactivityPref(rep({}), "daily_briefing").enabled === true);
check(
  "daily_briefing OFF via coluna legada",
  resolveProactivityPref(rep({ daily_briefing_enabled: false }), "daily_briefing").enabled === false,
);

// Sanidade da matriz
check("matriz tem 14 regras", Object.keys(PROACTIVITY_DEFAULTS).length === 14);

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
