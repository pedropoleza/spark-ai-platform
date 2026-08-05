/**
 * Testes do prompt do Resumo matinal (fix 2026-08-05).
 *
 * O que se protege aqui: toda reunião e todo compromisso do Google TEM que
 * chegar ao texto do prompt como linha pronta pra copiar. O bug era o modelo
 * receber os 7 compromissos do Pedro e devolver "Dia lotado — e mais alguns".
 *
 * Rodar: npx tsx scripts/test-briefing-prompt.ts
 */
import { buildDailyBriefingPrompt } from "../src/lib/account-assistant/proactive/daily-briefing-prompt";
import type { BriefingContext } from "../src/lib/account-assistant/proactive/daily-briefing";

let pass = 0,
  fail = 0;
function ok(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

const base: BriefingContext = {
  rep_name: "Natalia Freguglia",
  rep_first_name: "Natalia",
  date_label: "Quarta-feira, 5 de agosto",
  weekday: "Quarta-feira",
  timezone: "America/New_York",
  active_location_id: "loc1",
  appointments_today: [],
  blocks_today: [],
  blocks_truncated_count: 0,
  tasks_pending: [],
  yesterday: { deals_closed: [], notes_created: 0, tasks_completed: 0, tasks_total: 0 },
  has_any_content: true,
};

// ── 1. O dia real da Natalia: só compromisso do Google ──────────────────────
console.log("\n1. dia só com agenda do Google (caso Natalia 05/08)");
{
  const ctx: BriefingContext = {
    ...base,
    blocks_today: [
      { start_time_label: "8:00 AM", end_time_label: "8:10 AM", title: "FPL", source: "google_calendar" },
      { start_time_label: "10:30 AM", end_time_label: "11:30 AM", title: "Mel Oliveira e Cynthia", source: "google_calendar" },
      { start_time_label: "12:00 PM", end_time_label: "1:00 PM", title: "M4 - do Blue ao Jacket", source: "google_calendar" },
      { start_time_label: "3:00 PM", end_time_label: "7:00 PM", title: "BREAK  KIDS", source: "google_calendar" },
      { start_time_label: "7:00 PM", end_time_label: "8:00 PM", title: "Mentoria 2 - dos 5 clientes aos 20k", source: "google_calendar" },
    ],
  };
  const p = buildDailyBriefingPrompt(ctx);
  for (const b of ctx.blocks_today) {
    ok(`"${b.title}" aparece no prompt`, p.includes(b.title));
    ok(`horário de "${b.title}" aparece`, p.includes(`${b.start_time_label}–${b.end_time_label}`));
  }
  ok("manda COPIAR as linhas", /COPIE AS 5 LINHA/.test(p));
  ok("proíbe trocar por resumo", p.includes("NUNCA troque essa lista por um resumo"));
  ok("sem reuniões do CRM, manda pular a seção 📅", p.includes("appointments_today está vazio"));
}

// ── 2. O dia do Pedro: as duas agendas juntas ───────────────────────────────
console.log("\n2. reuniões do CRM + compromissos do Google (caso Pedro 05/08)");
{
  const ctx: BriefingContext = {
    ...base,
    rep_first_name: "John",
    appointments_today: [
      { start_time_iso: "2026-08-05T15:00:00Z", start_time_label: "11:00 AM", contact_name: "Thais", calendar_name: "Demo - Spark Leads" },
      { start_time_iso: "2026-08-05T16:00:00Z", start_time_label: "12:00 PM", contact_name: "Claionara", calendar_name: "Demo - Spark Leads" },
      { start_time_iso: "2026-08-05T19:00:00Z", start_time_label: "3:00 PM", contact_name: "Jussara", calendar_name: "Demo - Spark Leads" },
    ],
    blocks_today: [
      { start_time_label: "8:00 AM", end_time_label: "9:00 AM", title: "Workout Session", source: "google_calendar" },
      { start_time_label: "9:30 PM", end_time_label: "10:30 PM", title: "Reunião semanal", source: "google_calendar" },
    ],
  };
  const p = buildDailyBriefingPrompt(ctx);
  for (const a of ctx.appointments_today) ok(`reunião "${a.contact_name}" aparece`, p.includes(a.contact_name));
  for (const b of ctx.blocks_today) ok(`compromisso "${b.title}" aparece`, p.includes(b.title));
  ok("as duas seções são separadas", p.includes("NUNCA misture com a seção 📅"));
}

// ── 3. Truncamento e vazios ────────────────────────────────────────────────
console.log("\n3. truncamento e seções vazias");
{
  const ctx: BriefingContext = {
    ...base,
    blocks_today: [{ start_time_label: "8:00 AM", end_time_label: "9:00 AM", title: "Workout", source: "google_calendar" }],
    blocks_truncated_count: 4,
  };
  const p = buildDailyBriefingPrompt(ctx);
  ok("mostra o '+N outro(s)' quando trunca", p.includes("+4 outro(s)"));
}
{
  const p = buildDailyBriefingPrompt(base);
  ok("dia vazio manda pular as duas seções", p.includes("appointments_today está vazio") && p.includes("blocks_today está vazio"));
  ok("não sobrou o limite de 10 linhas que engolia a agenda", !p.includes("max 10 linhas"));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
