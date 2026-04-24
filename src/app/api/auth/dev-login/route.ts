import { NextResponse } from "next/server";
import { createSession, upsertLocation } from "@/lib/auth/sso";

const DEV_LOCATION_ID = "dWzIwfxbFny2t38NN9uG";
const DEV_COMPANY_ID = "dev-company";
const DEV_USER_ID = "dev-user";
const DEV_LOCATION_NAME = "Dev Location (Spark AI Hub)";

export async function POST() {
  // Defesa em camadas: precisa das 3 condições simultaneamente.
  // - DEV_MODE (server-only, não vaza no bundle)
  // - NEXT_PUBLIC_DEV_MODE (pro botão aparecer na UI — legacy)
  // - NODE_ENV !== "production" (Vercel seta automaticamente em prod)
  const devModeServer = process.env.DEV_MODE === "true";
  const devModePublic = process.env.NEXT_PUBLIC_DEV_MODE === "true";
  const isProduction = process.env.NODE_ENV === "production";
  if (!devModeServer || !devModePublic || isProduction) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await upsertLocation(
      DEV_LOCATION_ID,
      DEV_COMPANY_ID,
      DEV_LOCATION_NAME,
      "America/New_York"
    );

    await createSession({
      userId: DEV_USER_ID,
      companyId: DEV_COMPANY_ID,
      locationId: DEV_LOCATION_ID,
      locationName: DEV_LOCATION_NAME,
      isAdmin: true,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha no dev-login";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
