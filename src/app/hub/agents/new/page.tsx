import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { listTemplates, listEntitlements } from "@/lib/repositories/agent-platform.repo";
import { isEntitlementsEnforced } from "@/lib/agent-platform/entitlements";
import { templateCapability } from "@/lib/hub/data";
import { NewAgentFlow, type NewTemplate } from "./new-agent-flow";

// Ordem dos tiles: Venda e Recrutamento primeiro (mais comuns), Custom por último.
const TILE_ORDER: Record<string, number> = { sales: 0, recruitment: 1, custom: 2 };

export const dynamic = "force-dynamic";

export default async function NewAgentPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const [templates, entitlements] = await Promise.all([
    listTemplates({ audience: "lead" }),
    listEntitlements(session.locationId),
  ]);

  const now = Date.now();
  const activeCaps = new Set(
    entitlements
      .filter((e) => e.status === "active" && (!e.expires_at || new Date(e.expires_at).getTime() > now))
      .map((e) => e.capability),
  );

  // UI espelha o backend: o gate de criação é flag-aware (AGENT_ENTITLEMENTS_ENFORCED).
  // Com a flag OFF (default, log-first), o POST NÃO bloqueia — então NÃO mostramos
  // "Bloqueado" (senão a UI trava algo que o backend deixaria passar). Com a flag ON,
  // aí sim exige admin OU entitlement ativo.
  const enforced = isEntitlementsEnforced();
  const items: NewTemplate[] = templates
    .map((t) => {
      const cap = templateCapability(t.key);
      return {
        key: t.key,
        name: t.name,
        description: t.description || "",
        default_modules: t.default_modules || [],
        entitled: !enforced || session.isAdmin || (cap ? activeCaps.has(cap) : true),
      };
    })
    .sort((a, b) => (TILE_ORDER[a.key] ?? 99) - (TILE_ORDER[b.key] ?? 99));

  return <NewAgentFlow templates={items} />;
}
