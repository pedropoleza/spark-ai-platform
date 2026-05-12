/**
 * Daily Briefing: pré-carrega contexto pro "Resumo matinal" proativo.
 *
 * Filosofia: cron faz queries pesadas UMA vez, passa data estruturada
 * via contextData pro dispatcher. LLM só formata a mensagem — não chama
 * tools (evita N round-trips, latência consistente, prompt cache hit).
 *
 * Se TODAS as 3 seções (appointments, tasks, yesterday) ficarem vazias,
 * retorna `null` — cron pula o disparo (anti-spam "Bom dia, nada pra hoje").
 *
 * Pedro 2026-05-12: NÃO mencionar deals fechados se foi 0. Aplica mesmo
 * principle a todas seções vazias.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import type { RepIdentity } from "@/types/account-assistant";

export interface BriefingAppointment {
  start_time_iso: string;
  start_time_label: string; // "10:00 AM"
  contact_name: string;
  calendar_name?: string;
  title?: string;
}

export interface BriefingTask {
  title: string;
  due_date?: string;
  overdue_days?: number; // 0 se vence hoje, >0 se atrasada
  contact_name?: string;
}

export interface BriefingDealClosed {
  contact_name: string;
  premium_usd?: number; // se conhecido
  product?: string;
}

export interface BriefingYesterday {
  deals_closed: BriefingDealClosed[];   // [] = não menciona
  notes_created: number;
  tasks_completed: number;
  tasks_total: number;
}

export interface BriefingContext {
  rep_name: string;
  rep_first_name: string;
  date_label: string;      // "Quarta-feira, 12 de maio"
  weekday: string;         // "Quarta-feira"
  timezone: string;
  active_location_id: string;
  appointments_today: BriefingAppointment[];
  tasks_pending: BriefingTask[];
  yesterday: BriefingYesterday;
  has_any_content: boolean; // false → cron skipa send
}

const WEEKDAYS_PT: Record<string, string> = {
  Sunday: "Domingo",
  Monday: "Segunda-feira",
  Tuesday: "Terça-feira",
  Wednesday: "Quarta-feira",
  Thursday: "Quinta-feira",
  Friday: "Sexta-feira",
  Saturday: "Sábado",
};

const MONTHS_PT: Record<string, string> = {
  January: "janeiro", February: "fevereiro", March: "março",
  April: "abril", May: "maio", June: "junho",
  July: "julho", August: "agosto", September: "setembro",
  October: "outubro", November: "novembro", December: "dezembro",
};

/**
 * Calcula janela [start, end] (UTC ms) do "today" no timezone do rep.
 * Igual lógica do calendar.ts:computeWindowInTz.
 */
function dayWindowInTz(
  daysOffset: number,
  timezone: string,
): { startMs: number; endMs: number } {
  let tzUsed = timezone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tzUsed });
  } catch {
    tzUsed = "America/New_York";
  }
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tzUsed,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const todayStr = fmt.format(new Date());
  const addDays = (dateStr: string, days: number): string => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const targetDateStr = addDays(todayStr, daysOffset);

  const startOfDayInTz = (dateStr: string): number => {
    const utcMidnight = new Date(`${dateStr}T00:00:00Z`);
    const utcMs = utcMidnight.getTime();
    const tzFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzUsed,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = tzFmt.formatToParts(utcMidnight);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
    const tzAsIfUtc = Date.UTC(
      parseInt(get("year"), 10),
      parseInt(get("month"), 10) - 1,
      parseInt(get("day"), 10),
      parseInt(get("hour"), 10) === 24 ? 0 : parseInt(get("hour"), 10),
      parseInt(get("minute"), 10),
      parseInt(get("second"), 10),
    );
    const offsetMs = tzAsIfUtc - utcMs;
    return utcMs - offsetMs;
  };

  const startMs = startOfDayInTz(targetDateStr);
  const endStr = addDays(targetDateStr, 1);
  const endMs = startOfDayInTz(endStr) - 1;
  return { startMs, endMs };
}

/**
 * Carrega contexto completo pro briefing matinal do rep.
 * Retorna `null` se rep não tem nada de relevante (anti-spam).
 *
 * Não-fatal: falhas em queries individuais (GHL down etc) retornam
 * arrays vazios e seguem. Briefing parcial é melhor que nenhum.
 */
export async function loadDailyContext(
  rep: RepIdentity,
): Promise<BriefingContext | null> {
  const supabase = createAdminClient();
  const tz = rep.timezone || "America/New_York";

  // Resolve location ativa
  const activeLocId =
    rep.active_location_id ||
    rep.ghl_users?.[0]?.location_id ||
    null;
  if (!activeLocId) {
    console.warn(`[daily-briefing] rep ${rep.id} sem active_location_id`);
    return null;
  }
  const repGhlUserId = rep.ghl_users.find(
    (u) => u.location_id === activeLocId,
  )?.ghl_user_id;
  if (!repGhlUserId) {
    console.warn(
      `[daily-briefing] rep ${rep.id} sem ghl_user_id em ${activeLocId}`,
    );
    return null;
  }

  const { data: loc } = await supabase
    .from("locations")
    .select("company_id, location_name")
    .eq("location_id", activeLocId)
    .maybeSingle();
  if (!loc?.company_id) return null;

  const ghl = new GHLClient(loc.company_id, activeLocId);

  // Windows no tz do rep
  const today = dayWindowInTz(0, tz);
  const yesterday = dayWindowInTz(-1, tz);

  // Paralelo: appointments hoje, tasks pending, yesterday data
  type EventsResp = {
    events?: Array<{
      id: string;
      title?: string;
      startTime: string;
      endTime: string;
      contactId?: string;
      assignedUserId?: string;
      appointmentStatus?: string;
      calendarId?: string;
    }>;
  };
  // Tasks endpoint GHL — geralmente /contacts/{id}/tasks. Sem endpoint
  // global por user na free API. Skip por enquanto; V2 implementa via
  // search agregado ou novo endpoint quando disponível.
  const [eventsRes, _calRes] = await Promise.allSettled([
    ghl.get<EventsResp>("/calendars/events", {
      locationId: activeLocId,
      userId: repGhlUserId,
      startTime: String(today.startMs),
      endTime: String(today.endMs),
    }),
    ghl.get<{ calendars?: Array<{ id: string; name?: string }> }>(
      "/calendars/",
      { locationId: activeLocId },
    ),
  ]);

  // Appointments hoje (filter por assignedUserId client-side)
  const appointments_today: BriefingAppointment[] = [];
  if (eventsRes.status === "fulfilled") {
    const events = eventsRes.value.events || [];
    const calMap = new Map<string, string>();
    if (_calRes.status === "fulfilled") {
      for (const c of _calRes.value.calendars || []) {
        if (c.id && c.name) calMap.set(c.id, c.name);
      }
    }
    for (const ev of events) {
      if (ev.assignedUserId !== repGhlUserId) continue;
      const status = (ev.appointmentStatus || "scheduled").toLowerCase();
      if (["cancelled", "noshow", "no-show", "invalid"].includes(status)) continue;
      const startMs = new Date(ev.startTime).getTime();
      if (isNaN(startMs)) continue;

      const timeLabel = new Date(startMs).toLocaleTimeString("en-US", {
        timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
      });

      // Resolve nome do contato
      let contactName = "(sem nome)";
      if (ev.contactId) {
        try {
          const c = await ghl.get<{ contact?: { name?: string; firstName?: string } }>(
            `/contacts/${ev.contactId}`,
          );
          contactName =
            c.contact?.name ||
            c.contact?.firstName ||
            "(sem nome)";
        } catch {
          /* skip */
        }
      }
      appointments_today.push({
        start_time_iso: ev.startTime,
        start_time_label: timeLabel,
        contact_name: contactName,
        calendar_name: calMap.get(ev.calendarId || "") || undefined,
        title: ev.title,
      });
    }
    appointments_today.sort((a, b) =>
      a.start_time_iso.localeCompare(b.start_time_iso),
    );
  }

  // Yesterday recap: notes/tasks via sparkbot_messages audit
  // (tools criadas pelo bot ontem). Não é 100% — só captura o que bot
  // executou. Mas é o que temos sem custom GHL query.
  const yesterdayStartIso = new Date(yesterday.startMs).toISOString();
  const yesterdayEndIso = new Date(yesterday.endMs).toISOString();

  // Notes criadas
  const { count: notesCount } = await supabase
    .from("sparkbot_messages")
    .select("id", { count: "exact", head: true })
    .eq("rep_id", rep.id)
    .gte("created_at", yesterdayStartIso)
    .lte("created_at", yesterdayEndIso)
    .filter("metadata->tools", "cs", JSON.stringify(["create_note"]));

  // Tasks completadas pelo bot
  const { count: tasksCompletedCount } = await supabase
    .from("sparkbot_messages")
    .select("id", { count: "exact", head: true })
    .eq("rep_id", rep.id)
    .gte("created_at", yesterdayStartIso)
    .lte("created_at", yesterdayEndIso)
    .filter("metadata->tools", "cs", JSON.stringify(["complete_task"]));

  // Total de tasks criadas (pra dar contexto "completou X de Y")
  const { count: tasksCreatedCount } = await supabase
    .from("sparkbot_messages")
    .select("id", { count: "exact", head: true })
    .eq("rep_id", rep.id)
    .gte("created_at", yesterdayStartIso)
    .lte("created_at", yesterdayEndIso)
    .filter("metadata->tools", "cs", JSON.stringify(["create_task"]));

  // Deals fechados ontem: opportunities movidas pra status='won' em
  // sparkbot_messages (via update_opportunity_status). Pedro 2026-05-12:
  // NÃO mencionar se 0 — deixamos lista vazia e prompt template skipa
  // a seção inteira.
  const { count: dealsWonCount } = await supabase
    .from("sparkbot_messages")
    .select("id", { count: "exact", head: true })
    .eq("rep_id", rep.id)
    .gte("created_at", yesterdayStartIso)
    .lte("created_at", yesterdayEndIso)
    .filter(
      "metadata->tools",
      "cs",
      JSON.stringify(["update_opportunity_status"]),
    );

  // V1 simples: contagem só. V2 pode extrair contact_name + premium dos
  // tool_calls.input pra detalhar cada deal.
  const deals_closed: BriefingDealClosed[] = [];
  for (let i = 0; i < (dealsWonCount || 0); i++) {
    deals_closed.push({ contact_name: "(detalhar V2)" });
  }

  const yesterday_data: BriefingYesterday = {
    deals_closed, // [] se 0 → prompt template skipa
    notes_created: notesCount || 0,
    tasks_completed: tasksCompletedCount || 0,
    tasks_total: tasksCreatedCount || 0,
  };

  // Date label
  const todayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
  const parts = todayFmt.match(/^(\w+), (\w+) (\d+)$/);
  let date_label = todayFmt;
  let weekday = "Hoje";
  if (parts) {
    const [, wd, month, day] = parts;
    weekday = WEEKDAYS_PT[wd] || wd;
    date_label = `${weekday}, ${day} de ${MONTHS_PT[month] || month.toLowerCase()}`;
  }

  // Skip-empty: se tudo zero, retorna null (cron skipa)
  const hasYesterday =
    yesterday_data.deals_closed.length > 0 ||
    yesterday_data.notes_created > 0 ||
    yesterday_data.tasks_completed > 0;
  const hasContent =
    appointments_today.length > 0 ||
    /* tasks_pending: V2 */
    hasYesterday;

  if (!hasContent) {
    return null;
  }

  // Tasks pending: V2 (GHL não tem endpoint /tasks global por user)
  const tasks_pending: BriefingTask[] = [];

  return {
    rep_name: rep.display_name || "rep",
    rep_first_name: (rep.display_name || "").split(" ")[0] || "rep",
    date_label,
    weekday,
    timezone: tz,
    active_location_id: activeLocId,
    appointments_today,
    tasks_pending,
    yesterday: yesterday_data,
    has_any_content: true,
  };
}
