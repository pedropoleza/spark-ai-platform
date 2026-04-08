import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { GHLClient } from "@/lib/ghl/client";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  try {
    const client = new GHLClient(session.companyId, session.locationId);

    let calendars: unknown[] = [];
    try {
      const data = await client.get<{ calendars: unknown[] }>("/calendars/", {
        locationId: session.locationId,
      });
      calendars = data.calendars || [];
    } catch {
      try {
        const data = await client.get<{ calendars: unknown[] }>(
          `/calendars/services`,
          { locationId: session.locationId }
        );
        calendars = data.calendars || [];
      } catch (e) {
        console.error("Erro ao buscar calendarios:", e);
      }
    }

    return NextResponse.json({ calendars });
  } catch (error) {
    console.error("Erro ao buscar calendarios:", error);
    return NextResponse.json({ calendars: [] });
  }
}
