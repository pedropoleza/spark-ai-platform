import { NextRequest, NextResponse } from "next/server";
import { validateGHLUser, upsertLocation, createSession } from "@/lib/auth/sso";
import { GHLClient } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { ssoSchema, validateBody } from "@/lib/utils/validation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { data, error } = validateBody(ssoSchema, body);

    if (error || !data) {
      return NextResponse.json({ error: error || "Dados invalidos" }, { status: 400 });
    }

    // F42 (Pedro 2026-06-02): GHL Custom Menu Link só interpola {{user.id}} +
    // {{location.id}}. Quando company_id vier vazio, descobre via tabela
    // locations (populada pelo OAuth install). Fail-closed se nem isso achar.
    let companyId = data.company_id || "";
    if (!companyId) {
      const supabase = createAdminClient();
      const { data: loc } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", data.location_id)
        .maybeSingle();
      if (loc?.company_id) {
        companyId = loc.company_id;
        console.log("[SSO] company_id descoberto via locations table:", { locationId: data.location_id, companyId });
      } else {
        console.warn("[SSO] company_id ausente e location não encontrada:", { locationId: data.location_id });
        return NextResponse.json(
          { error: "company_id ausente e location_id não tem registro prévio. Re-instale o app via OAuth pra criar o vínculo." },
          { status: 400 },
        );
      }
    }

    const validationResult = await validateGHLUser(
      companyId,
      data.location_id,
      data.user_id
    );

    if (!validationResult) {
      return NextResponse.json({ error: "Falha na validacao do usuario" }, { status: 403 });
    }

    const { user, isAdmin } = validationResult;

    // Buscar timezone da location via GHL API
    let locationTimezone = "America/New_York";
    let locationName = user.name || "Minha Location";
    try {
      const client = new GHLClient(companyId, data.location_id);
      const locationData = await client.get<{
        location?: { timezone?: string; name?: string; };
        timezone?: string;
        name?: string;
      }>(`/locations/${data.location_id}`);

      const tz = locationData.location?.timezone || locationData.timezone;
      // Validar timezone contra lista conhecida
      if (tz && isValidTimezone(tz)) locationTimezone = tz;
      const name = locationData.location?.name || locationData.name;
      if (name) locationName = name;
    } catch {
      console.log("[SSO] Could not fetch location timezone, using default");
    }

    console.log("[SSO] User authenticated:", {
      id: data.user_id,
      locationName,
      timezone: locationTimezone,
    });

    await upsertLocation(data.location_id, companyId, locationName, locationTimezone);

    await createSession({
      userId: data.user_id,
      companyId,
      locationId: data.location_id,
      locationName,
      isAdmin,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro no SSO:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
