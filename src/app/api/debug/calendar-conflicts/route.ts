import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";

export const maxDuration = 30;

/**
 * Debug temporário 2026-05-05: investiga 3 fontes de horário ocupado pra
 * uma location, pra entender se /calendars/blocked-slots cobre Google
 * Calendar synced events ou só GHL-native blocks.
 *
 * Caso real: cliente +1 (786) 461-5477 location YuR0LCZomFzrfkDK2ezo
 * tem Google Calendar integrado, blocks aparecem no UI mas /free-slots
 * não considera.
 *
 * Auth: Bearer cron secret. REMOVER após resolver.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const locationId = url.searchParams.get("location_id") || "YuR0LCZomFzrfkDK2ezo";
  const calendarId = url.searchParams.get("calendar_id");
  const userId = url.searchParams.get("user_id");
  const daysAhead = parseInt(url.searchParams.get("days") || "1");

  const supabase = createAdminClient();
  const { data: location } = await supabase
    .from("locations")
    .select("company_id, location_name, timezone")
    .eq("location_id", locationId)
    .maybeSingle();
  if (!location) {
    return NextResponse.json({ ok: false, reason: "location_not_synced" });
  }

  const ghl = new GHLClient(location.company_id, locationId);
  const out: Record<string, unknown> = {
    location: { id: locationId, name: location.location_name, timezone: location.timezone, company: location.company_id },
  };

  // 1. Lista calendars da location
  try {
    const calRes = await ghl.get<{
      calendars?: Array<{
        id: string;
        name?: string;
        teamMembers?: Array<{ userId: string; isPrimary?: boolean }>;
      }>;
    }>("/calendars/", { locationId });
    out.calendars = (calRes.calendars || []).map((c) => ({
      id: c.id,
      name: c.name,
      team_members: c.teamMembers?.map((tm) => tm.userId) || [],
    }));
  } catch (err) {
    out.calendars_error = err instanceof Error ? err.message : String(err);
  }

  const now = Date.now();
  const startMs = now;
  const endMs = now + daysAhead * 24 * 60 * 60_000;
  const targetCalendar = calendarId || ((out.calendars as Array<{ id: string }>) || [])[0]?.id;
  if (!targetCalendar) {
    return NextResponse.json({ ...out, error: "no_calendar_id_resolved" });
  }
  out.target_calendar_id = targetCalendar;
  out.window = {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };

  // 2. Free slots via endpoint atual
  try {
    const freeRes = await ghl.get<Record<string, unknown>>(
      `/calendars/${targetCalendar}/free-slots`,
      {
        startDate: String(startMs),
        endDate: String(endMs),
        timezone: location.timezone || "America/New_York",
        ...(userId ? { userId } : {}),
      },
    );
    out.free_slots_raw = freeRes;
  } catch (err) {
    out.free_slots_error = err instanceof Error ? err.message : String(err);
  }

  // 3. Blocked slots — endpoint que Pedro mencionou
  try {
    const blockedRes = await ghl.get<Record<string, unknown>>(
      "/calendars/blocked-slots",
      {
        locationId,
        startTime: String(startMs),
        endTime: String(endMs),
        ...(userId ? { userId } : {}),
        ...(targetCalendar ? { calendarId: targetCalendar } : {}),
      },
    );
    out.blocked_slots_raw = blockedRes;
  } catch (err) {
    out.blocked_slots_error = err instanceof Error ? err.message : String(err);
  }

  // 4. Events — incluindo Google Calendar synced
  try {
    const eventsRes = await ghl.get<Record<string, unknown>>("/calendars/events", {
      locationId,
      startTime: String(startMs),
      endTime: String(endMs),
      ...(userId ? { userId } : {}),
      ...(targetCalendar ? { calendarId: targetCalendar } : {}),
    });
    out.events_raw = eventsRes;
  } catch (err) {
    out.events_error = err instanceof Error ? err.message : String(err);
  }

  // 5. Endpoint alternativo: /calendars/events/appointments (filter contactId? no)
  // 6. /calendars/events com groupId (categoria de calendars)
  // Try `/calendars/events?groupId=xxx`
  // 7. Events ALL — sem filtros
  try {
    const eventsAll = await ghl.get<Record<string, unknown>>("/calendars/events", {
      locationId,
      startTime: String(startMs),
      endTime: String(endMs),
    });
    out.events_no_filter = eventsAll;
  } catch (err) {
    out.events_no_filter_error = err instanceof Error ? err.message : String(err);
  }

  // 8. /calendars/groups (talvez calendars sejam organizados por groupId)
  try {
    const groupsRes = await ghl.get<Record<string, unknown>>("/calendars/groups", { locationId });
    out.groups_raw = groupsRes;
  } catch (err) {
    out.groups_error = err instanceof Error ? err.message : String(err);
  }

  // 9. Try /calendars/events com userIds (plural)
  if (userId) {
    try {
      const eventsByUsers = await ghl.get<Record<string, unknown>>("/calendars/events", {
        locationId,
        startTime: String(startMs),
        endTime: String(endMs),
        userIds: userId,
      });
      out.events_by_userids = eventsByUsers;
    } catch (err) {
      out.events_by_userids_error = err instanceof Error ? err.message : String(err);
    }
  }

  // 10. Iterar TODOS os calendars do user e ver se alguém retorna events
  if (userId) {
    const calendarsArray = (out.calendars as Array<{ id: string; name: string; team_members: string[] }>) || [];
    const userCalendars = calendarsArray.filter((c) => c.team_members.includes(userId));
    const eventsPerCalendar: Record<string, { count: number; sample: unknown[] }> = {};
    for (const cal of userCalendars) {
      try {
        const r = await ghl.get<{ events?: unknown[] }>("/calendars/events", {
          locationId,
          startTime: String(startMs),
          endTime: String(endMs),
          calendarId: cal.id,
        });
        const events = r.events || [];
        eventsPerCalendar[cal.name] = {
          count: events.length,
          sample: events.slice(0, 3),
        };
      } catch (err) {
        eventsPerCalendar[cal.name] = {
          count: -1,
          sample: [`error: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    }
    out.events_per_calendar = eventsPerCalendar;
  }

  return NextResponse.json({ ok: true, ...out });
}
