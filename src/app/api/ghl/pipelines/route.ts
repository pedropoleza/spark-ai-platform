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

    let pipelines: unknown[] = [];
    try {
      const data = await client.get<{ pipelines: unknown[] }>(
        "/opportunities/pipelines",
        { locationId: session.locationId }
      );
      pipelines = data.pipelines || [];
    } catch {
      try {
        const data = await client.get<{ pipelines: unknown[] }>(
          `/locations/${session.locationId}/pipelines`
        );
        pipelines = data.pipelines || [];
      } catch (e) {
        console.error("Erro ao buscar pipelines:", e);
      }
    }

    return NextResponse.json({ pipelines });
  } catch (error) {
    console.error("Erro ao buscar pipelines:", error);
    return NextResponse.json({ pipelines: [] });
  }
}
