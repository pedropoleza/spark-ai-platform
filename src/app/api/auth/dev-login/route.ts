import { NextResponse } from "next/server";
import { createSession, upsertLocation } from "@/lib/auth/sso";

const DEV_LOCATION_ID = "dWzIwfxbFny2t38NN9uG";
const DEV_COMPANY_ID = "dev-company";
const DEV_USER_ID = "dev-user";
const DEV_LOCATION_NAME = "Dev Location (Matrix AI Hub)";

export async function POST() {
  if (process.env.NEXT_PUBLIC_DEV_MODE !== "true") {
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
