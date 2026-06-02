import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { HubShell } from "./hub-shell";
import "./hub.css";

/**
 * Layout do /hub — UI canônica.
 *
 * Fix bug observado em prod 2026-06-02 (F42): o gate hubPreviewAllowed
 * redirecionava locations fora da allowlist pra /dashboard, mas /dashboard já
 * havia sido deletado (F2 task #142) e virou redirect 308 → /hub (cutover
 * PM-F3.I parcial em next.config.mjs). Resultado: loop /hub→/dashboard→/hub
 * → ERR_TOO_MANY_REDIRECTS → tela branca no Custom Menu Link do Spark Leads.
 * Cutover completo agora: /hub libera pra qualquer sessão válida.
 */
export default async function HubLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/");

  return <HubShell session={session}>{children}</HubShell>;
}
