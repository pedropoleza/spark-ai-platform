import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { listTemplates, listEntitlements } from "@/lib/repositories/agent-platform.repo";
import { templateCapability } from "@/lib/hub/data";
import { NewAgentFlow, type NewTemplate } from "./new-agent-flow";

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

  const items: NewTemplate[] = templates.map((t) => {
    const cap = templateCapability(t.key);
    return {
      key: t.key,
      name: t.name,
      description: t.description || "",
      default_modules: t.default_modules || [],
      // Admin libera tudo; senão precisa de entitlement ativo da capacidade.
      entitled: session.isAdmin || (cap ? activeCaps.has(cap) : true),
    };
  });

  return <NewAgentFlow templates={items} />;
}
