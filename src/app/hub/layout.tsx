import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/sso";
import { HubShell } from "./hub-shell";
import "./hub.css";

/**
 * Layout do /hub (UI nova, paralela ao /dashboard).
 *
 * Gate de preview (Pedro 2026-05-25 — cutover em paralelo): em produção o /hub
 * só aparece pras locations no allowlist (env HUB_PREVIEW_LOCATIONS) ou quando
 * a flag global NEXT_PUBLIC_NEW_HUB_UI=1 estiver ligada. Quem não tem acesso cai
 * no /dashboard atual (que segue no ar). Em dev local, sempre liberado.
 * `isAdmin` do SSO é amplo demais pra servir de gate (role "user" já é admin).
 */
function hubPreviewAllowed(locationId: string): boolean {
  if (process.env.NEXT_PUBLIC_NEW_HUB_UI === "1") return true;
  if (process.env.NODE_ENV !== "production") return true;
  const allow = (process.env.HUB_PREVIEW_LOCATIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(locationId);
}

export default async function HubLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/");

  // Cookie soft-gate: entrar pelo link de preview (/?...&next=/hub&preview=1)
  // seta hub_preview=1 — assim você prevê sem mexer em env. Clientes usam o link
  // normal (sem preview), nunca recebem o cookie e seguem no /dashboard.
  const previewCookie = (await cookies()).get("hub_preview")?.value === "1";
  if (!hubPreviewAllowed(session.locationId) && !previewCookie) redirect("/dashboard");

  return <HubShell session={session}>{children}</HubShell>;
}
