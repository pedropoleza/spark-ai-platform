import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";
import type { RepIdentity } from "@/types/account-assistant";

export const maxDuration = 60;

/**
 * GET /api/debug/post-meeting-check?rep_id=<id>
 *
 * Endpoint debug temporário (2026-05-04): replica a lógica do cron
 * post_meeting pra ver o que ele está vendo e por que não dispara.
 * Retorna por location: events brutos do GHL + filtros aplicados +
 * decisão final.
 *
 * Auth: SSO session (admin only). Remover quando bug estiver resolvido.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const repId =
    url.searchParams.get("rep_id") || "1eeb02cc-1a48-4b56-b177-52dcbca07ac2";
  const hoursWindow = parseInt(url.searchParams.get("hours") || "0") || 0;
  const noUserFilter = url.searchParams.get("no_user_filter") === "1";
  const onlyLocationId = url.searchParams.get("location_id");
  const calendarId = url.searchParams.get("calendar_id");
  const listCalendars = url.searchParams.get("list_calendars") === "1";
  const appointmentId = url.searchParams.get("appointment_id");

  const supabase = createAdminClient();
  const { data: rep } = await supabase
    .from("rep_identities")
    .select("*")
    .eq("id", repId)
    .maybeSingle();
  if (!rep) {
    return NextResponse.json({ ok: false, reason: "rep_not_found" }, { status: 404 });
  }
  const r = rep as RepIdentity;

  const offsetMinutes = 0;
  const offsetMs = offsetMinutes * 60_000;
  const GRACE_MS = 30 * 60_000;
  const now = Date.now();
  const windowStart = now - GRACE_MS;
  const windowEnd = now + offsetMs;
  // Se hoursWindow setado, expande pra capturar appointments mais distantes
  // (debug: "criei mas o filtro não pegou — o que tem na location?")
  const queryStart = hoursWindow > 0
    ? now - hoursWindow * 60 * 60_000
    : windowStart - 60 * 60_000;
  const queryEnd = hoursWindow > 0
    ? now + hoursWindow * 60 * 60_000
    : windowEnd + 60_000;

  const locationsByRep = new Map<string, string>();
  for (const u of r.ghl_users || []) {
    if (u?.location_id && u?.ghl_user_id && !locationsByRep.has(u.location_id)) {
      locationsByRep.set(u.location_id, u.ghl_user_id);
    }
  }

  const results: Array<Record<string, unknown>> = [];
  for (const [locationId, ghlUserId] of locationsByRep) {
    if (onlyLocationId && locationId !== onlyLocationId) continue;
    const { data: location } = await supabase
      .from("locations")
      .select("location_id, company_id")
      .eq("location_id", locationId)
      .maybeSingle();
    if (!location) {
      results.push({
        location_id: locationId,
        ghl_user_id: ghlUserId,
        skipped: "location_not_synced",
      });
      continue;
    }

    try {
      const ghlClient = new GHLClient(location.company_id, locationId);

      // Modo appointment_id: pega o appointment cru com todos os campos
      // (createdAt, timezone, dateAdded, etc). Útil pra debugar problemas
      // de timezone — comparar com o que o GHL retorna em /calendars/events.
      if (appointmentId) {
        const apptRes = await ghlClient.get<{
          appointment?: Record<string, unknown>;
        }>(`/calendars/events/appointments/${appointmentId}`);
        results.push({
          location_id: locationId,
          ghl_user_id: ghlUserId,
          company_id: location.company_id,
          server_now: new Date().toISOString(),
          appointment_raw: apptRes.appointment,
        });
        continue;
      }

      // Modo list_calendars: retorna lista de calendars da location pra
      // identificar onde o appointment foi criado.
      if (listCalendars) {
        const calRes = await ghlClient.get<{
          calendars?: Array<{
            id: string;
            name?: string;
            description?: string;
            isActive?: boolean;
            teamMembers?: Array<{ userId?: string }>;
          }>;
        }>("/calendars/", { locationId });
        results.push({
          location_id: locationId,
          ghl_user_id: ghlUserId,
          company_id: location.company_id,
          calendars: (calRes.calendars || []).map((c) => ({
            id: c.id,
            name: c.name,
            is_active: c.isActive,
            team_members: c.teamMembers?.map((tm) => tm.userId) || [],
          })),
        });
        continue;
      }

      // Query parâmetros: ou userId (default) ou calendarId (override)
      const queryParams: Record<string, string> = {
        locationId,
        startTime: String(queryStart),
        endTime: String(queryEnd),
      };
      if (calendarId) {
        queryParams.calendarId = calendarId;
      } else if (!noUserFilter) {
        queryParams.userId = ghlUserId;
      }

      const res = await ghlClient.get<{
        events?: Array<{
          id: string;
          title?: string;
          startTime: string;
          endTime: string;
          contactId?: string;
          appointmentStatus?: string;
          assignedUserId?: string;
        }>;
      }>("/calendars/events", queryParams);

      const events = res.events || [];
      const annotated = events.map((event) => {
        const endMs = new Date(event.endTime).getTime();
        const status = (event.appointmentStatus || "scheduled").toLowerCase();
        const inWindow = !isNaN(endMs) && endMs >= windowStart && endMs <= windowEnd;
        const statusOk = !["cancelled", "noshow", "no-show", "invalid"].includes(status);
        return {
          id: event.id,
          title: event.title || null,
          start_time: event.startTime,
          end_time: event.endTime,
          end_ms: isNaN(endMs) ? null : endMs,
          window_start: windowStart,
          window_end: windowEnd,
          in_window: inWindow,
          status,
          status_ok: statusOk,
          would_fire: inWindow && statusOk,
          assigned_user_id: event.assignedUserId,
          contact_id: event.contactId || null,
        };
      });
      results.push({
        location_id: locationId,
        ghl_user_id: ghlUserId,
        company_id: location.company_id,
        events_count: events.length,
        events: annotated,
      });
    } catch (err) {
      results.push({
        location_id: locationId,
        ghl_user_id: ghlUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    rep: {
      id: r.id,
      display_name: r.display_name,
      phone: r.phone,
      active_location_id: r.active_location_id,
      num_locations: locationsByRep.size,
    },
    window: {
      now: new Date(now).toISOString(),
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(windowEnd).toISOString(),
      grace_minutes: 30,
      offset_minutes: offsetMinutes,
    },
    results,
  });
}
