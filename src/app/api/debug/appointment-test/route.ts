import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";

export const maxDuration = 30;

/**
 * GET /api/debug/appointment-test
 *
 * Debug temporário 2026-05-04: reproduz o create_appointment que falhou
 * pra Pedro (location Spark Leads, calendar Client Appointment, Marcela
 * Siqueira quarta 13h SP) e retorna o erro CRU do GHL — ghlErrorToResult
 * mascara o detalhe pro LLM.
 *
 * Também lista calendar com team_members e calendar settings completos
 * pra identificar se o assignedUserId está no time members.
 *
 * Auth: Bearer cron secret. REMOVER após resolver.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const locationId = "efZEjK6PqtPGDHqB2vV6"; // Spark Leads
  const calendarId = "G6ShJJuRXoKiefITNQTW"; // Client Appointment - Spark Leads
  const contactId = "FbP1pn1yljk7muWAdB1B"; // Marcela Siqueira (com phone)
  const assignedUserId = "ScQSEMxK6jEFqTAhK88Y"; // Pedro nessa location

  const { data: location } = await supabase
    .from("locations")
    .select("company_id, location_name, timezone")
    .eq("location_id", locationId)
    .maybeSingle();
  if (!location) {
    return NextResponse.json({ ok: false, reason: "location_not_found" });
  }

  const ghl = new GHLClient(location.company_id, locationId);
  const out: Record<string, unknown> = {
    location: { id: locationId, name: location.location_name, timezone: location.timezone, company: location.company_id },
  };

  // 1. Calendar detalhe + team_members
  try {
    const calRes = await ghl.get<{
      calendar?: Record<string, unknown>;
    }>(`/calendars/${calendarId}`);
    out.calendar_details = calRes.calendar;
  } catch (err) {
    out.calendar_details_error = err instanceof Error ? err.message : String(err);
  }

  // 2. Tenta criar com 3 variações pra isolar a causa:
  //    A) Idêntico ao que rodou em prod (com assignedUserId)
  //    B) Sem assignedUserId
  //    C) Com timezone EDT em vez de SP
  const startSP = "2026-05-06T13:00:00-03:00"; // 16:00 UTC
  const endSP = "2026-05-06T14:00:00-03:00";   // 17:00 UTC

  // Variation A: igual prod
  try {
    const res = await ghl.post<unknown>("/calendars/events/appointments", {
      calendarId,
      contactId,
      locationId,
      startTime: new Date(startSP).toISOString(),
      endTime: new Date(endSP).toISOString(),
      title: "DEBUG - Marcela Siqueira (variation A: with assignedUserId)",
      assignedUserId,
    });
    out.variation_a_with_assignee = { ok: true, response: res };
  } catch (err) {
    out.variation_a_with_assignee = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Variation B: sem assignedUserId
  try {
    const res = await ghl.post<unknown>("/calendars/events/appointments", {
      calendarId,
      contactId,
      locationId,
      startTime: new Date(startSP).toISOString(),
      endTime: new Date(endSP).toISOString(),
      title: "DEBUG - Marcela Siqueira (variation B: no assignedUserId)",
    });
    out.variation_b_no_assignee = { ok: true, response: res };
  } catch (err) {
    out.variation_b_no_assignee = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return NextResponse.json({ ok: true, ...out });
}
