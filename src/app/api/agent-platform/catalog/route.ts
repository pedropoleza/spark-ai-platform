/**
 * GET /api/agent-platform/catalog
 *
 * Alimenta o wizard de criação de agente: templates + módulos do catálogo +
 * entitlements da location logada (pra saber o que já está liberado / o que é
 * upsell). Auth via SSO. Plataforma Modular (Fase 3).
 */
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { listTemplates, listModules, listEntitlements } from "@/lib/repositories/agent-platform.repo";
import { capabilityForAgentType } from "@/lib/agent-platform/entitlements";

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorized();

  try {
    const [templates, modules, entitlements] = await Promise.all([
      listTemplates(),
      listModules(),
      listEntitlements(session.locationId),
    ]);

    // Capacidades ATIVAS (não-expiradas) da location — o wizard usa pra marcar
    // template pago como liberado vs upsell.
    const now = Date.now();
    const activeCapabilities = entitlements
      .filter((e) => e.status === "active" && (!e.expires_at || new Date(e.expires_at).getTime() > now))
      .map((e) => e.capability);

    return NextResponse.json({
      templates,
      modules,
      activeCapabilities,
      isAdmin: session.isAdmin,
      // helper pro client: dado um template, qual capability ele exige (null = incluso)
      capabilityByTemplate: Object.fromEntries(
        templates.map((t) => [t.key, capabilityFor(t.key)]),
      ),
    });
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : "erro", 500, "catalog_error");
  }
}

/** template key → capability paga (sparkbot = null/incluso). */
function capabilityFor(templateKey: string): string | null {
  switch (templateKey) {
    case "sparkbot":
      return null;
    case "sales":
      return capabilityForAgentType("sales_agent");
    case "recruitment":
      return capabilityForAgentType("recruitment_agent");
    default:
      return capabilityForAgentType("custom_agent");
  }
}
