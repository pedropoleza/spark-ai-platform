import { NextRequest, NextResponse } from "next/server";
import { validateGHLUser, upsertLocation, createSession } from "@/lib/auth/sso";
import { GHLClient } from "@/lib/ghl/client";
import { ssoSchema, validateBody } from "@/lib/utils/validation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { data, error } = validateBody(ssoSchema, body);

    if (error || !data) {
      return NextResponse.json({ error: error || "Dados invalidos" }, { status: 400 });
    }

    const validationResult = await validateGHLUser(
      data.company_id,
      data.location_id,
      data.user_id
    );

    if (!validationResult) {
      return NextResponse.json({ error: "Falha na validacao do usuario" }, { status: 403 });
    }

    const { user } = validationResult;

    // Buscar timezone da location via GHL API
    let locationTimezone = "America/New_York";
    let locationName = user.name || "Minha Location";
    try {
      const client = new GHLClient(data.company_id, data.location_id);
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

    await upsertLocation(data.location_id, data.company_id, locationName, locationTimezone);

    await createSession({
      userId: data.user_id,
      companyId: data.company_id,
      locationId: data.location_id,
      locationName,
      isAdmin: true,
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
