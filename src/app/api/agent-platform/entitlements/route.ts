/**
 * POST /api/agent-platform/entitlements — libera (grant) uma capacidade paga
 * pra um escritório (location). Admin-only. Substitui o scripts/grant-entitlement.
 *
 * Body: { location_id, capability: "sales"|"recruitment"|"custom", price_usd?, expires_at? }
 * Segurança: só admin; a location precisa pertencer à company do admin.
 * Plataforma Modular — Fase G (Acessos).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { grantEntitlement } from "@/lib/repositories/agent-platform.repo";
import { toCapability, assertLocationInCompany } from "@/lib/agent-platform/entitlement-admin";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();
  if (!session.isAdmin) return errorResponse("Apenas admin pode liberar acessos.", 403, "forbidden");

  const body = await req.json().catch(() => ({}));
  const locationId = String(body.location_id || "").trim();
  const capability = toCapability(String(body.capability || ""));
  if (!locationId || !capability) return errorResponse("location_id e capability válidos são obrigatórios.", 400, "bad_request");

  if (!(await assertLocationInCompany(locationId, session.companyId))) {
    return errorResponse("Escritório não encontrado nesta conta.", 404, "not_found");
  }

  const priceUsd = typeof body.price_usd === "number" && body.price_usd >= 0 ? body.price_usd : undefined;
  const expiresAt = typeof body.expires_at === "string" && body.expires_at.trim() ? body.expires_at.trim() : null;

  try {
    const entitlement = await grantEntitlement({
      locationId,
      capability,
      grantedBy: session.userId,
      priceUsd,
      expiresAt,
    });
    return NextResponse.json({ ok: true, entitlement });
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : "erro", 500, "grant_error");
  }
}
