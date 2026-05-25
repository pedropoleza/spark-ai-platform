/**
 * POST /api/agent-platform/entitlements/revoke — revoga a capacidade ativa de
 * um escritório. Admin-only + company-scoped. Plataforma Modular — Fase G.
 *
 * Body: { location_id, capability: "sales"|"recruitment"|"custom" }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { revokeEntitlement } from "@/lib/repositories/agent-platform.repo";
import { toCapability, assertLocationInCompany } from "@/lib/agent-platform/entitlement-admin";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();
  if (!session.isAdmin) return errorResponse("Apenas admin pode revogar acessos.", 403, "forbidden");

  const body = await req.json().catch(() => ({}));
  const locationId = String(body.location_id || "").trim();
  const capability = toCapability(String(body.capability || ""));
  if (!locationId || !capability) return errorResponse("location_id e capability válidos são obrigatórios.", 400, "bad_request");

  if (!(await assertLocationInCompany(locationId, session.companyId))) {
    return errorResponse("Escritório não encontrado nesta conta.", 404, "not_found");
  }

  try {
    const revoked = await revokeEntitlement(locationId, capability, session.userId);
    return NextResponse.json({ ok: true, revoked });
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : "erro", 500, "revoke_error");
  }
}
