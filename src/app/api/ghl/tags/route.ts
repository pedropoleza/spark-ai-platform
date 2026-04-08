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

    let tags: unknown[] = [];
    try {
      // Endpoint v2: /locations/{locationId}/tags
      const data = await client.get<{ tags: unknown[] }>(
        `/locations/${session.locationId}/tags`
      );
      tags = data.tags || [];
    } catch {
      try {
        // Fallback
        const data = await client.get<{ tags: unknown[] }>("/locations/tags", {
          locationId: session.locationId,
        });
        tags = data.tags || [];
      } catch (e) {
        console.error("Erro ao buscar tags:", e);
      }
    }

    return NextResponse.json({ tags });
  } catch (error) {
    console.error("Erro ao buscar tags:", error);
    return NextResponse.json({ tags: [] });
  }
}
